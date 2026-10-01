import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkAdmission } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { markRequesterSettleWakePending } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-delivery.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";

function applyCleanupBookkeeping(
  cleanup: CleanupBookkeepingParams,
  suppressSessionEffects: boolean,
  retireAfterSettle: boolean,
): void {
  const { entry } = cleanup;
  entry.cleanupCompletedAt = cleanup.completedAt;
  if (suppressSessionEffects) {
    entry.execution = {
      ...entry.execution,
      restartRecovery: undefined,
      suppressSessionEffects: true,
    };
    entry.terminalOwner = undefined;
  }
  if (entry.collect) {
    entry.requesterSettleWake = undefined;
  } else if (!cleanup.skipRequesterSettleWake) {
    markRequesterSettleWakePending(entry, { retireAfterSettle });
  }
}

export async function completeCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanupParams: CleanupBookkeepingParams,
): Promise<void> {
  const params = context.options;
  const stateContext = cleanupParams.stateContext ?? captureOpenClawStateWorkerContext();
  // Bookkeeping can retire the row; detached child effects refresh currency below.
  const suppressSessionEffects = !context.sessionEffectsHostCurrent(cleanupParams.entry);
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (
      cleanupParams.isCurrent?.() === false ||
      context.sessionEffectsHostCurrent(cleanupParams.entry) === suppressSessionEffects
    ) {
      throw new Error("Subagent cleanup owner changed before bookkeeping.");
    }
  };
  const scheduleCleanupTails = (options: {
    allowRetiredRow: boolean;
    isDeleteCleanup: boolean;
  }) => {
    // Retained bookkeeping requires the exact row. Immediate retirement
    // removes it first, so absence remains ownership only while no newer
    // child generation exists; any replacement blocks the stale cleanup.
    const postBookkeepingEffectsAllowed = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = params.runs.get(cleanupParams.runId);
      const rowOwnershipMatches =
        current === cleanupParams.entry || (options.allowRetiredRow && current === undefined);
      return (
        rowOwnershipMatches &&
        cleanupParams.isCurrent?.() !== false &&
        !context.newerGenerationOwnsSession(cleanupParams.entry) &&
        context.sessionEffectsHostCurrent(cleanupParams.entry)
      );
    };
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // Admission can outlive the caller's async scope. Own the tail's lifetime
      // and recheck row ownership after waiting; surviving tails still block snapshots.
      void runWithGatewayDetachedWorkAdmission(async () => {
        if (
          !(await context.shouldSuppressSessionEffects(cleanupParams.entry)) &&
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
        removeInternalSessionEffectsSession(cleanupParams.entry.execution.transcriptTarget),
      );
    }
    if (cleanupParams.entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", () =>
        retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupParams.entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
              childSessionKey: maskLifecycleIdentifier(
                cleanupParams.entry.childSessionKey,
                "session",
              ),
            });
          },
        }),
      );
    }
    if (
      !cleanupParams.provisionalKill &&
      (options.isDeleteCleanup || !cleanupParams.entry.collect)
    ) {
      runCleanupTail("context-engine cleanup", () =>
        params.notifyContextEngineSubagentEnded(
          {
            childSessionKey: cleanupParams.entry.childSessionKey,
            reason: options.isDeleteCleanup ? "deleted" : "completed",
            agentDir: cleanupParams.entry.agentDir,
            workspaceDir: cleanupParams.entry.workspaceDir,
          },
          {
            isCurrent: postBookkeepingEffectsAllowed,
            prepareCurrent: async () =>
              !(await context.shouldSuppressSessionEffects(cleanupParams.entry)) &&
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
  const retireAfterSettle =
    !cleanupParams.entry.collect &&
    (isDeleteCleanup ||
      (cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        cleanupParams.entry.suppressAnnounceReason !== "killed"));
  const retireImmediately = retireAfterSettle && cleanupParams.skipRequesterSettleWake === true;
  const assertPublishedOwner = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = params.runs.get(cleanupParams.runId);
    if (
      cleanupParams.isCurrent?.() === false ||
      (retireImmediately ? current !== undefined : current !== cleanupParams.entry)
    ) {
      throw new Error("Subagent cleanup owner changed after publication.");
    }
  };
  // Collector tombstones and announcing runs share the same durable cleanup
  // boundary; only announcing runs keep a requester-settle obligation.
  await commitSubagentLifecycleMutation(context, {
    entry: cleanupParams.entry,
    stateContext,
    assertCurrent,
    retire: retireImmediately,
    mutate: () => {
      cleanupParams.discardDelivery?.();
      if (!retireImmediately) {
        applyCleanupBookkeeping(cleanupParams, suppressSessionEffects, retireAfterSettle);
      }
    },
  });
  assertPublishedOwner();
  if (retireImmediately) {
    subagentRuns.confirmRetirement(cleanupParams.entry);
  }
  if (retireImmediately || cleanupParams.entry.collect || cleanupParams.skipRequesterSettleWake) {
    clearGatewayContextResolver(cleanupParams.entry);
  }
  if (isDeleteCleanup || retireAfterSettle) {
    params.clearPendingLifecycleError(cleanupParams.runId);
  }
  // A settle wake may retire its durably marked row before detached tails start.
  // A replacement row or newer child generation still fences these effects.
  scheduleCleanupTails({ allowRetiredRow: retireAfterSettle, isDeleteCleanup });
  assertPublishedOwner();
  context.resumeAncestorCleanup(cleanupParams.entry);
  if (!cleanupParams.entry.collect && !cleanupParams.skipRequesterSettleWake) {
    assertPublishedOwner();
    scheduleRequesterSettleWake(context, cleanupParams.runId, cleanupParams.entry, stateContext);
  }
}
