import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;

export function createSubagentRegistryCompletionRuntime(config: {
  runs: Map<string, SubagentRunRecord>;
  resumed: Set<object>;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  completeSubagentRun: (params: SubagentCompletionRequest) => Promise<void>;
  scheduleSweep: (params?: { delayMs?: number }) => void;
  resumeRun: (runId: string) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, resumed, retryTimers, completeSubagentRun, scheduleSweep, resumeRun, warn } =
    config;

  const currentEntry = (params: Pick<SubagentCompletionRequest, "runId" | "expectedEntry">) =>
    params.expectedEntry
      ? getCurrentSubagentRunOwner(runs, params.expectedEntry)
      : runs.get(params.runId);

  async function completeSubagentRunWithRecoveryAttempt(
    params: SubagentCompletionRequest,
    source: string,
    isCurrent: () => Promise<boolean>,
  ) {
    for (const message of [
      "failed to complete subagent run; retrying completion",
      "failed to complete subagent run after retry; retrying ended cleanup",
    ]) {
      if (!(await isCurrent())) {
        return;
      }
      try {
        await completeSubagentRun(params);
        return;
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        const current = currentEntry(params);
        warn(message, {
          source,
          runId: params.runId,
          childSessionKey: current?.childSessionKey,
          error,
        });
        if (!(await isCurrent())) {
          return;
        }
      }
    }

    if (!(await isCurrent())) {
      return;
    }
    const latest = currentEntry(params);
    if (latest && typeof latest.execution.endedAt !== "number") {
      // A refused commit leaves the published row nonterminal. Preserve the
      // completion through the normal persisted-session recovery path.
      scheduleSweep({ delayMs: 1_000 });
      return;
    }
    if (
      !latest ||
      typeof latest.execution.endedAt !== "number" ||
      typeof latest.cleanupCompletedAt === "number" ||
      latest.pauseReason === "sessions_yield"
    ) {
      return;
    }
    const resumeKey = getSubagentRunRuntimeKey(latest);
    const resume = await mutateSubagentRuns(
      [latest.runId],
      (rows) => {
        const current = rows.get(latest.runId);
        if (!current || !isSameSubagentRunOwner(current, latest)) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent cleanup address changed before recovery",
          );
        }
        if (
          typeof current.cleanupCompletedAt === "number" ||
          current.pauseReason === "sessions_yield"
        ) {
          return { value: false };
        }
        return {
          value: true,
          postimages: new Map([[current.runId, { ...current, cleanupHandled: false }]]),
        };
      },
      {
        runs,
        assertCurrent: () => {
          if (params.recoveryCurrent?.isHostCurrent() === false) {
            throw new SubagentRegistryMutationRejectedError(
              "Subagent completion recovery owner changed",
            );
          }
        },
      },
    );
    const resumedEntry = resume ? getCurrentSubagentRunOwner(runs, latest) : undefined;
    if (resumedEntry && params.recoveryCurrent?.isHostCurrent() !== false) {
      resumed.delete(resumeKey);
      resumeRun(resumedEntry.runId);
    }
  }

  function scheduleSubagentCompletionRetryAfterRestart(
    params: SubagentCompletionRequest,
    source: string,
    expectedEntry: SubagentRunRecord,
  ) {
    const expectedGeneration = expectedEntry.generation;
    const ownedParams = { ...params, expectedEntry };
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      const current = getCurrentSubagentRunOwner(runs, expectedEntry);
      if (
        !isSameSubagentRunOwner(current, expectedEntry) ||
        current?.generation !== expectedGeneration
      ) {
        return;
      }
      completeSubagentRunInBackground(
        ownedParams,
        source,
        "failed to retry subagent completion after gateway restart",
      );
    }, GATEWAY_ADMISSION_RETRY_DELAY_MS);
    timer.unref?.();
    retryTimers.add(timer);
  }

  async function completeSubagentRunWithRecovery(
    params: SubagentCompletionRequest,
    source: string,
  ) {
    const entry = currentEntry(params);
    if (!entry || (params.expectedEntry && !isSameSubagentRunOwner(params.expectedEntry, entry))) {
      return;
    }
    const generation = entry.generation;
    const stateContext = captureOpenClawStateWorkerContext();
    const isHostCurrent = () => {
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        return false;
      }
      return (
        Boolean(getCurrentSubagentRunOwner(runs, entry)) &&
        entry.generation === generation &&
        params.recoveryCurrent?.isHostCurrent() !== false
      );
    };
    const isCurrent = async () =>
      isHostCurrent() && (await params.recoveryCurrent?.prepare()) !== false && isHostCurrent();
    const ownedParams = {
      ...params,
      expectedEntry: entry,
      recoveryCurrent: {
        prepare: isCurrent,
        isHostCurrent,
        onPublished: (published: SubagentRunRecord) =>
          params.recoveryCurrent?.onPublished?.(published),
      },
    };
    // Each controller attempt owns its terminal transition, while this outer
    // lease outlives the launch scope and spans retries and fallback cleanup.
    try {
      await runWithGatewayDetachedWorkContinuation(async () => {
        await completeSubagentRunWithRecoveryAttempt(ownedParams, source, isCurrent);
      }, "subagents:completion");
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      if (!(await isCurrent())) {
        return;
      }
      if (!isGatewayRestartDraining()) {
        throw error;
      }
      warn("subagent completion deferred during gateway restart", {
        source,
        runId: params.runId,
      });
      scheduleSubagentCompletionRetryAfterRestart(params, source, entry);
    }
  }

  // Awaited callers own rejection; detached timers must log it instead of exiting the Gateway.
  function completeSubagentRunInBackground(
    params: SubagentCompletionRequest,
    source: string,
    warning = "failed to complete subagent run in background",
  ) {
    void completeSubagentRunWithRecovery(params, source).catch((error: unknown) => {
      warn(warning, { source, runId: params.runId, error });
    });
  }

  const pendingLifecycle = createPendingLifecycleScheduler({
    runs,
    completeInBackground: completeSubagentRunInBackground,
  });

  function hasCompleteSubagentTerminalState(entry: SubagentRunRecord | undefined): boolean {
    return (
      entry !== undefined &&
      typeof entry.execution.endedAt === "number" &&
      Number.isFinite(entry.execution.endedAt) &&
      entry.execution.outcome !== undefined &&
      entry.endedReason !== undefined &&
      entry.execution.status === "terminal"
    );
  }

  async function finalizeInterruptedSubagentRun(params: {
    runId: string;
    expectedEntry?: SubagentRunRecord;
    recoveryCurrent?: SubagentCompletionRequest["recoveryCurrent"];
    sessionEffects?: SubagentCompletionRequest["sessionEffects"];
    error: string;
    endedAt?: number;
    suppressSessionEffects?: boolean;
  }): Promise<number> {
    const runId = params.runId.trim();
    if (!runId) {
      return 0;
    }

    const endedAt =
      typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
        ? params.endedAt
        : Date.now();
    const entry = currentEntry({ ...params, runId });
    const generation = entry?.generation;
    if (
      !entry ||
      (params.expectedEntry && !isSameSubagentRunOwner(entry, params.expectedEntry)) ||
      (params.recoveryCurrent && !(await params.recoveryCurrent.prepare())) ||
      params.recoveryCurrent?.isHostCurrent() === false ||
      !getCurrentSubagentRunOwner(runs, entry) ||
      entry.generation !== generation
    ) {
      return 0;
    }
    pendingLifecycle.clear(runId);
    if (
      typeof entry.cleanupCompletedAt === "number" &&
      entry.terminalOwner !== "interrupted-recovery"
    ) {
      return hasCompleteSubagentTerminalState(entry) ? 1 : 0;
    }
    let publishedEntry = entry;
    const completionParams: SubagentCompletionRequest = {
      runId,
      expectedEntry: entry,
      endedAt,
      outcome: {
        status: "error",
        error: params.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      recoverInterrupted: true,
      recoveryCurrent: {
        prepare: async () => (await params.recoveryCurrent?.prepare()) !== false,
        isHostCurrent: () => params.recoveryCurrent?.isHostCurrent() !== false,
        onPublished(published) {
          if (!isSameSubagentRunOwner(published, entry)) {
            throw new SubagentRegistryMutationRejectedError(
              "Subagent recovery publication changed its execution owner",
            );
          }
          publishedEntry = published;
          params.recoveryCurrent?.onPublished?.(published);
        },
      },
      sessionEffects: params.sessionEffects,
      suppressSessionEffects: params.suppressSessionEffects,
    };
    try {
      await completeSubagentRun(completionParams);
      // Cleanup can retire the row before this call returns; retain its acknowledged result.
      const finalized = getCurrentSubagentRunOwner(runs, publishedEntry) ?? publishedEntry;
      // Recovery preserves partial terminal evidence instead of overwriting it.
      // Keep scheduler retries alive until the exact row is fully terminal.
      return hasCompleteSubagentTerminalState(finalized) ? 1 : 0;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      if (isGatewayRestartDraining() && Boolean(getCurrentSubagentRunOwner(runs, entry))) {
        warn("subagent completion deferred during gateway restart", {
          source: "explicit-failed-mark",
          runId,
        });
        scheduleSubagentCompletionRetryAfterRestart(
          completionParams,
          "explicit-failed-mark",
          entry,
        );
        return 1;
      }
      warn("failed to durably finalize interrupted subagent run", {
        runId,
        childSessionKey: entry.childSessionKey,
        error,
      });
      return 0;
    }
  }

  return {
    pendingLifecycle,
    completeSubagentRunWithRecovery,
    finalizeInterruptedSubagentRun,
  };
}
