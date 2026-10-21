import { isDeepStrictEqual } from "node:util";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000;

type PendingLifecycleKind = "error" | "timeout";

type PendingLifecycleParams = {
  runId: string;
  expectedEntry: SubagentRunRecord;
  endedAt: number;
  startedAt?: number;
  cancellation?: true;
  error?: string;
  terminalReply?: SubagentCompletionRequest["terminalReply"];
};

type PendingLifecycleTerminal = PendingLifecycleParams & {
  kind: PendingLifecycleKind;
  timer: NodeJS.Timeout;
};

export function createPendingLifecycleScheduler(params: {
  runs: Map<string, SubagentRunRecord>;
  completeInBackground: (completion: SubagentCompletionRequest, source: string) => void;
}) {
  const pendingByRunId = new Map<string, PendingLifecycleTerminal>();

  function clearKind(runId: string, kind?: PendingLifecycleKind) {
    const pending = pendingByRunId.get(runId);
    if (!pending || (kind && pending.kind !== kind)) {
      return;
    }
    clearTimeout(pending.timer);
    pendingByRunId.delete(runId);
  }

  const canComplete = (
    kind: PendingLifecycleKind,
    entry: SubagentRunRecord,
    expected: SubagentRunRecord,
  ) =>
    entry.execution.startedAt === expected.execution.startedAt &&
    entry.pauseReason !== "sessions_yield" &&
    entry.execution.outcome?.status !== "ok" &&
    (kind !== "error" || entry.endedReason !== SUBAGENT_ENDED_REASON_COMPLETE);

  function schedule(kind: PendingLifecycleKind, scheduleParams: PendingLifecycleParams) {
    const selected = scheduleParams.expectedEntry;
    const currentAtSchedule = getCurrentSubagentRunOwner(params.runs, selected);
    if (!currentAtSchedule || !canComplete(kind, currentAtSchedule, selected)) {
      return;
    }
    clearKind(scheduleParams.runId);
    const timer = setTimeout(() => {
      const pending = pendingByRunId.get(scheduleParams.runId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingByRunId.delete(scheduleParams.runId);
      const entry = getCurrentSubagentRunOwner(params.runs, pending.expectedEntry);
      if (!entry || !canComplete(kind, entry, pending.expectedEntry)) {
        return;
      }
      let publication: Pick<SubagentRunRecord, "execution" | "endedReason"> | undefined;
      const isCurrent = () => {
        const current = getCurrentSubagentRunOwner(params.runs, pending.expectedEntry);
        return (
          current !== undefined &&
          current.pauseReason !== "sessions_yield" &&
          (publication
            ? current.endedReason === publication.endedReason &&
              isDeepStrictEqual(current.execution, publication.execution)
            : canComplete(kind, current, pending.expectedEntry))
        );
      };
      params.completeInBackground(
        {
          runId: entry.runId,
          expectedEntry: entry,
          // Yield or retry-start can commit after this timer fires, before terminal admission.
          recoveryCurrent: {
            prepare: async () => isCurrent(),
            isHostCurrent: isCurrent,
            onPublished: ({ execution, endedReason }) => {
              // Deadline normalization can change a cancellation into this owner's timeout.
              publication = { execution, endedReason };
            },
          },
          endedAt: pending.endedAt,
          outcome:
            kind === "timeout"
              ? { status: "timeout" }
              : {
                  status: "error",
                  error: pending.cancellation ? "subagent run terminated" : pending.error,
                },
          reason: pending.cancellation
            ? SUBAGENT_ENDED_REASON_KILLED
            : kind === "error"
              ? SUBAGENT_ENDED_REASON_ERROR
              : SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt: pending.startedAt,
          terminalReply: pending.terminalReply,
        },
        pending.cancellation ? "lifecycle-cancellation-grace" : `lifecycle-${kind}-grace`,
      );
    }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
    timer.unref?.();
    pendingByRunId.set(scheduleParams.runId, { ...scheduleParams, kind, timer });
  }

  return {
    clear: clearKind,
    clearPriorAttempt: (runId: string) => {
      const pending = pendingByRunId.get(runId);
      const current = params.runs.get(runId);
      if (
        pending &&
        current &&
        pending.expectedEntry.execution.startedAt !== current.execution.startedAt
      ) {
        clearKind(runId);
      }
    },
    clearError: (runId: string) => clearKind(runId, "error"),
    clearTimeout: (runId: string) => clearKind(runId, "timeout"),
    clearAll() {
      pendingByRunId.forEach(({ timer }) => clearTimeout(timer));
      pendingByRunId.clear();
    },
    scheduleCancellation: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("error", { ...scheduleParams, cancellation: true }),
    scheduleError: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("error", scheduleParams),
    scheduleTimeout: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("timeout", scheduleParams),
    sweepExpired(now: number) {
      for (const [runId, pending] of pendingByRunId) {
        if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
          clearKind(runId, pending.kind);
        }
      }
    },
  };
}
