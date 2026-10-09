import { runWithGatewayDetachedWorkContinuation } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { markRequesterSettleWakePending } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-log.js";
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
  const stateContext = cleanupParams.stateContext ?? captureOpenClawStateWorkerContext();
  // Bookkeeping can retire the row; detached child effects refresh currency below.
  const suppressSessionEffects = !context.sessionEffectsHostCurrent(entry);
  const assertCurrent = (current: SubagentRunRecord) => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (
      cleanupParams.isCurrent?.() === false ||
      context.sessionEffectsHostCurrent(current) === suppressSessionEffects
    ) {
      throw new Error("Subagent cleanup owner changed before bookkeeping.");
    }
    entry = current;
  };
  const scheduleCleanupTails = (options: {
    allowRetiredRow: boolean;
    isDeleteCleanup: boolean;
  }) => {
    // Retired cleanup may continue only while no replacement owns this execution
    // and no newer child generation owns its session.
    const postBookkeepingEffectsAllowed = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = getCurrentSubagentRunOwner(params.runs, entry);
      const rowOwnershipMatches =
        current !== undefined || (options.allowRetiredRow && !params.runs.has(entry.runId));
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
      void runWithGatewayDetachedWorkContinuation(async () => {
        if (
          !(await context.shouldSuppressSessionEffects(entry)) &&
          postBookkeepingEffectsAllowed()
        ) {
          await run();
        }
      }, "subagents:lifecycle-cleanup").catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    // The admitted tails report their own failures after bookkeeping has committed.
    if (!cleanupParams.preserveTranscript) {
      runCleanupTail("session cleanup", () =>
        removeInternalSessionEffectsSession(entry.execution.transcriptTarget),
      );
    }
    if (entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", () =>
        retireSessionMcpRuntimeForSessionKey({
          sessionKey: entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
              childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
            });
          },
        }),
      );
    }
    if (!cleanupParams.provisionalKill && (options.isDeleteCleanup || !entry.collect)) {
      runCleanupTail("context-engine cleanup", () =>
        params.notifyContextEngineSubagentEnded(
          {
            childSessionKey: entry.childSessionKey,
            reason: options.isDeleteCleanup ? "deleted" : "completed",
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
    // The provider result or bounded kill reconciliation owns terminal settle.
    // Its kill marker was committed by the caller before reaching this tail.
    scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup: false });
    return;
  }
  const isDeleteCleanup = cleanupParams.cleanup === "delete";
  let retireAfterSettle = false;
  let retireImmediately = false;
  const assertPublishedOwner = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (
      cleanupParams.isCurrent?.() === false ||
      (retireImmediately
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
    retire: () => retireImmediately,
    mutate: (draft) => {
      // Cron reads settled child rows directly; delete rows retire through the archive sweep.
      retireAfterSettle =
        !draft.collect &&
        ((isDeleteCleanup && !isCronRunSessionKey(draft.requesterSessionKey)) ||
          (draft.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            draft.suppressAnnounceReason !== "killed"));
      retireImmediately = retireAfterSettle && cleanupParams.skipRequesterSettleWake === true;
      cleanupParams.discardDelivery?.(draft);
      if (!retireImmediately) {
        draft.cleanupCompletedAt = cleanupParams.completedAt;
        if (suppressSessionEffects) {
          draft.execution.restartRecovery = undefined;
          draft.execution.suppressSessionEffects = true;
          draft.terminalOwner = undefined;
        }
        if (draft.collect) {
          draft.requesterSettleWake = undefined;
        } else if (!cleanupParams.skipRequesterSettleWake) {
          markRequesterSettleWakePending(draft, { retireAfterSettle });
        }
      }
    },
  });
  assertPublishedOwner();
  if (retireImmediately) {
    subagentRuns.confirmRetirement(entry);
  }
  if (retireImmediately || entry.collect || cleanupParams.skipRequesterSettleWake) {
    retireSubagentGatewayBinding(entry);
  }
  if (isDeleteCleanup || retireAfterSettle) {
    params.clearPendingLifecycleError(entry.runId);
  }
  // A settle wake may retire its durably marked row before detached tails start.
  // A replacement row or newer child generation still fences these effects.
  scheduleCleanupTails({ allowRetiredRow: retireAfterSettle, isDeleteCleanup });
  assertPublishedOwner();
  context.resumeAncestorCleanup(entry);
  if (!entry.collect && !cleanupParams.skipRequesterSettleWake) {
    assertPublishedOwner();
    scheduleRequesterSettleWake(context, entry.runId, entry, stateContext);
  }
}
