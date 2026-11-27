import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { killSubagentRunAdmin } from "./registry/subagent-control-kill.js";
import { ensureSubagentControllerOwnsRun } from "./registry/subagent-control-scope.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type SubagentAdminKillResult,
} from "./registry/subagent-control.types.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./registry/subagent-registry-memory.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "./registry/subagent-registry-read.js";
import { isSubagentPausedByYield } from "./registry/subagent-requester-turn-custody.js";

type DormantStopResult = { cancelledRunId?: string; error?: string };

function projectDormantStopResult(result: SubagentAdminKillResult): DormantStopResult {
  return {
    cancelledRunId:
      result.found &&
      result.killed &&
      result.targetState?.state === "terminal" &&
      result.targetState.task.status === "cancelled" &&
      result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
        ? result.runId
        : undefined,
    error: result.found ? result.error : undefined,
  };
}

/** Capture registry-owned work that ordinary executor cancellation cannot reach. */
export function captureDormantSubagentStop(params: {
  sessionKey: string;
  agentId?: string;
  runId?: string;
}) {
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    undefined,
    params.agentId,
  );
  // The child index and exact-run lookup share the registry's resident record.
  if (
    !entry ||
    (!isSubagentRunQueued(entry) && !isSubagentPausedByYield(entry)) ||
    (params.runId && subagentRuns.get(params.runId) !== entry)
  ) {
    return undefined;
  }
  const parentSessionKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  return {
    runId: entry.runId,
    parent: {
      runId: entry.requesterTurnRunId,
      sessionKey: parentSessionKey,
      agentId: entry.requesterAgentId,
      storePath: entry.requesterStorePath,
    },
    assertCurrent(cfg: OpenClawConfig, controllerAgentId: string | undefined) {
      const current = getCurrentSubagentRunOwner(subagentRuns, entry);
      if (!current || (current.execution.status === "queued" && !isSubagentRunQueued(current))) {
        throw new Error("Dormant subagent obligation changed; retry Stop.");
      }
      const ownershipError = ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parentSessionKey, controllerAgentId },
        entry: current,
      });
      if (ownershipError) {
        throw new Error(ownershipError);
      }
    },
    async stop(
      cfg: OpenClawConfig,
      control: {
        assertCurrent: () => void;
        prepareRead?: () => Promise<void> | undefined;
        beforeSessionKill?: () => boolean | Promise<boolean>;
        requiredSessionId?: string;
        onSnapshot: (cancelledRunId: string | undefined) => void;
        onResult: (result: DormantStopResult) => undefined;
      },
    ): Promise<void> {
      const { onResult, onSnapshot, ...sessionControl } = control;
      await killSubagentRunAdmin(
        {
          cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedRunId: entry.runId,
          expectedGeneration: entry.generation,
          expectedOwnerKey: entry.requesterSessionKey,
          onResult: (result) => onResult(projectDormantStopResult(result)),
        },
        {
          ...sessionControl,
          onSnapshot: (result) => onSnapshot(projectDormantStopResult(result).cancelledRunId),
        },
      );
    },
  };
}
