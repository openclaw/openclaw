import { runWithGatewayDetachedWorkContinuation } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { retireSessionMcpRuntime } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { subagentTerminalTransition } from "../completion/subagent-terminal-transition.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { buildSafeLifecycleErrorMeta } from "./subagent-registry-lifecycle-log.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function completeCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanupParams: CleanupBookkeepingParams,
): Promise<void> {
  const params = context.options;
  let entry = getCurrentSubagentRunOwner(params.runs, cleanupParams.entry) ?? cleanupParams.entry;
  const authority = resolveSubagentChildAuthority(entry);
  if (authority.status === "mismatch") {
    throw new Error(authority.error);
  }
  const stateContext = cleanupParams.stateContext ?? captureOpenClawStateWorkerContext();
  // Bookkeeping can retire the row; detached child effects refresh currency below.
  const assertCurrent = (current: SubagentRunRecord) => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (
      cleanupParams.isCurrent?.() === false ||
      resolveSubagentChildAuthority(current).status === "mismatch"
    ) {
      throw new Error("Subagent cleanup owner changed before bookkeeping.");
    }
    entry = current;
  };
  const scheduleCleanupTails = (
    decision: ReturnType<typeof subagentTerminalTransition.cleanup>,
  ) => {
    // Retired cleanup may continue only while no replacement owns this execution
    // and no newer child generation owns its session.
    const postBookkeepingEffectsAllowed = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = getCurrentSubagentRunOwner(params.runs, entry);
      const rowOwnershipMatches =
        current !== undefined || (decision.retireAfterSettle && !params.runs.has(entry.runId));
      return (
        rowOwnershipMatches &&
        cleanupParams.isCurrent?.() !== false &&
        !context.newerGenerationOwnsSession(entry) &&
        context.sessionEffectsHostCurrent(entry)
      );
    };
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // Admission can outlive the caller's async scope. Own the tail's lifetime
      // and recheck row ownership after waiting; surviving tails still block snapshots.
      const cleanup = async () => {
        if (
          !(await context.shouldSuppressSessionEffects(entry)) &&
          postBookkeepingEffectsAllowed()
        ) {
          await run();
        }
      };
      void runWithGatewayDetachedWorkContinuation(
        () => context.runBackgroundWork(entry, cleanup),
        "subagents:lifecycle-cleanup",
      ).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    // The admitted tails report their own failures after bookkeeping has committed.
    if (decision.removeTranscript) {
      runCleanupTail("session cleanup", () =>
        removeInternalSessionEffectsSession(entry.execution.transcriptTarget),
      );
    }
    if (decision.retireMcp) {
      runCleanupTail("bundle MCP cleanup", () =>
        retireSessionMcpRuntime({
          sessionId: entry.childSessionIdentity?.sessionId,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: cleanupParams.runId,
              childSessionKey: entry.childSessionKey,
            });
          },
        }),
      );
    }
    const contextEndedReason = decision.contextEndedReason;
    if (contextEndedReason) {
      runCleanupTail("context-engine cleanup", () =>
        params.notifyContextEngineSubagentEnded(
          {
            childSessionKey: entry.childSessionKey,
            reason: contextEndedReason,
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          },
          {
            isCurrent: postBookkeepingEffectsAllowed,
            prepareCurrent: async () =>
              !(await context.shouldSuppressSessionEffects(entry)) &&
              postBookkeepingEffectsAllowed(),
          },
        ),
      );
    }
  };
  if (cleanupParams.provisionalKill) {
    // The provider result or the kill's confirmation owns terminal settle.
    // Its kill marker was committed by the caller before reaching this tail.
    scheduleCleanupTails(subagentTerminalTransition.cleanup(entry, cleanupParams, false));
    return;
  }
  let decision!: ReturnType<typeof subagentTerminalTransition.cleanup>;
  const assertPublishedOwner = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (
      cleanupParams.isCurrent?.() === false ||
      (decision.retireImmediately
        ? current !== undefined || params.runs.has(entry.runId)
        : current === undefined)
    ) {
      throw new Error("Subagent cleanup owner changed after publication.");
    }
  };
  // Collector tombstones and announcing runs share the same durable cleanup
  // boundary; only announcing runs keep a requester-settle obligation.
  entry = await commitSubagentLifecycleMutation(context, {
    entry,
    stateContext,
    assertCurrent,
    retire: () => decision.retireImmediately,
    mutate: (draft, current) => {
      const suppressSessionEffects = !context.sessionEffectsHostCurrent(current);
      cleanupParams.finalizeDelivery?.(draft);
      decision = subagentTerminalTransition.cleanup(draft, cleanupParams, suppressSessionEffects);
    },
  });
  assertPublishedOwner();
  if (decision.retireImmediately) {
    subagentRuns.confirmRetirement(entry);
  }
  if (decision.retireBinding) {
    retireSubagentGatewayBinding(entry);
  }
  if (decision.clearPendingError) {
    params.clearPendingLifecycleError(entry.runId);
  }
  // A settle wake may retire its durably marked row before detached tails start.
  // A replacement row or newer child generation still fences these effects.
  scheduleCleanupTails(decision);
  assertPublishedOwner();
  if (decision.wakeRequester) {
    scheduleRequesterSettleWake(context, entry.runId, entry, stateContext);
  }
  context.resumeAncestorCleanup(entry);
}
