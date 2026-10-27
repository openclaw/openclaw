import { isDeepStrictEqual } from "node:util";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { AgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { GATEWAY_ADMISSION_RETRY_DELAY_MS } from "./subagent-registry-helpers.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** Admit terminal evidence before transport-specific grace or deadline reconciliation. */
export async function prepareSubagentTerminalObservation(params: {
  entry: SubagentRunRecord;
  terminal: AgentRunTerminalOutcome;
  yielded: boolean;
  terminalReply?: SubagentCompletionRequest["terminalReply"];
  runs: Map<string, SubagentRunRecord>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  clearPending: () => void;
  adoptPaused: (entry: SubagentRunRecord) => Promise<boolean>;
  resumePaused: (entry: SubagentRunRecord) => void;
}): Promise<(SubagentCompletionRequest & { expectedEntry: SubagentRunRecord }) | undefined> {
  const { entry, terminal, runs, context, assertCurrent } = params;
  if (params.yielded && !entry.collect) {
    await mutateSubagentRuns(
      [entry.runId],
      (rows) => {
        const current = rows.get(entry.runId);
        if (!current || !isSameSubagentRunOwner(current, entry)) {
          throw new Error("Subagent yield lost its original run");
        }
        if (current.collect || current.killIntent || current.killReconciliation) {
          return { value: undefined };
        }
        const draft = structuredClone(current);
        return {
          value: undefined,
          ...(markSubagentRunPausedAfterYield({
            entry: draft,
            startedAt: terminal.startedAt ?? current.execution.startedAt,
            endedAt: terminal.endedAt,
          })
            ? { postimages: new Map([[entry.runId, draft]]) }
            : {}),
        };
      },
      { runs, context, assertCurrent },
    );
    assertCurrent();
    const paused = runs.get(entry.runId);
    if (paused?.pauseReason === "sessions_yield") {
      params.clearPending();
      if (!(await params.adoptPaused(paused)) && paused.requesterSettleWake?.pauseNotice) {
        assertCurrent();
        params.resumePaused(paused);
      }
    }
    return undefined;
  }
  assertCurrent();
  if (params.yielded) {
    params.clearPending();
  }
  // A collector has no continuation to resume it; its yielded turn is its result.
  const classification = params.yielded ? "success" : classifySubagentTerminalOutcome(terminal);
  const cancelled = classification === "cancellation";
  return {
    runId: entry.runId,
    expectedEntry: entry,
    endedAt: terminal.endedAt ?? Date.now(),
    startedAt: terminal.startedAt,
    terminalReply: params.terminalReply,
    outcome:
      classification === "success"
        ? { status: "ok" }
        : classification === "timeout"
          ? { status: "timeout" }
          : { status: "error", error: cancelled ? "subagent run terminated" : terminal.error },
    reason: cancelled
      ? SUBAGENT_ENDED_REASON_KILLED
      : classification === "success" || classification === "timeout"
        ? SUBAGENT_ENDED_REASON_COMPLETE
        : SUBAGENT_ENDED_REASON_ERROR,
    sendFarewell: true,
    accountId: entry.requesterOrigin?.accountId,
    triggerCleanup: true,
  };
}

export function createSubagentRegistryCompletionRuntime(config: {
  runs: Map<string, SubagentRunRecord>;
  resumed: Set<object>;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  completeSubagentRun: (params: SubagentCompletionRequest) => Promise<void>;
  resumeRun: (runId: string) => void;
}) {
  const { runs, resumed, retryTimers, completeSubagentRun, resumeRun } = config;

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
        subagentRegistryLog.warn(message, {
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
      // Keep the captured live result through a refused write. Hydrated history
      // never reconstructs terminal evidence after a process restart.
      scheduleSubagentCompletionRetry(params, source, latest);
      return;
    }
    if (
      !latest ||
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
            "Subagent cleanup address changed before retry",
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
              "Subagent completion retry owner changed",
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

  function scheduleSubagentCompletionRetry(
    params: SubagentCompletionRequest,
    source: string,
    expectedEntry: SubagentRunRecord,
  ) {
    const expectedGeneration = expectedEntry.generation;
    const ownedParams = { ...params, expectedEntry };
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      const current = getCurrentSubagentRunOwner(runs, expectedEntry);
      if (!current || current.generation !== expectedGeneration) {
        return;
      }
      completeSubagentRunInBackground(
        ownedParams,
        source,
        "failed to retry live subagent completion",
      );
    }, GATEWAY_ADMISSION_RETRY_DELAY_MS);
    timer.unref();
    retryTimers.add(timer);
  }

  async function completeSubagentRunWithRecovery(
    params: SubagentCompletionRequest,
    source: string,
  ) {
    const entry = currentEntry(params);
    if (!entry) {
      return;
    }
    const generation = entry.generation;
    const stateContext = captureOpenClawStateWorkerContext();
    let settledYielded: SubagentRunRecord | undefined;
    const isHostCurrent = () => {
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        return false;
      }
      const current = getCurrentSubagentRunOwner(runs, entry);
      return (
        current !== undefined &&
        entry.generation === generation &&
        params.recoveryCurrent?.isHostCurrent() !== false &&
        // Once our settle commits, retries may drain effects only for that terminal.
        (!settledYielded ||
          (current.execution.status === "terminal" &&
            current.pauseReason === undefined &&
            !current.killIntent &&
            !current.killReconciliation &&
            current.endedReason === settledYielded.endedReason &&
            current.execution.startedAt === settledYielded.execution.startedAt &&
            current.execution.endedAt === settledYielded.execution.endedAt &&
            isDeepStrictEqual(current.execution.outcome, settledYielded.execution.outcome)))
      );
    };
    const isCurrent = async () =>
      isHostCurrent() && (await params.recoveryCurrent?.prepare()) !== false && isHostCurrent();
    const ownedParams: SubagentCompletionRequest = {
      ...params,
      expectedEntry: entry,
      recoveryCurrent: {
        prepare: isCurrent,
        isHostCurrent,
        onPublished: (published: SubagentRunRecord) => {
          if (ownedParams.settleYielded) {
            settledYielded = published;
            // The pause is gone after our commit. Retry normal idempotent effects,
            // not the yield transition; isHostCurrent still rejects any replacement.
            ownedParams.settleYielded = undefined;
          }
          params.recoveryCurrent?.onPublished?.(published);
        },
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
      subagentRegistryLog.warn("subagent completion deferred during gateway drain", {
        source,
        runId: params.runId,
      });
      scheduleSubagentCompletionRetry(ownedParams, source, entry);
    }
  }

  // Awaited callers own rejection; detached timers must log it instead of exiting the Gateway.
  function completeSubagentRunInBackground(
    params: SubagentCompletionRequest,
    source: string,
    warning = "failed to complete subagent run in background",
  ) {
    void completeSubagentRunWithRecovery(params, source).catch((error: unknown) => {
      subagentRegistryLog.warn(warning, { source, runId: params.runId, error });
    });
  }

  const pendingLifecycle = createPendingLifecycleScheduler({
    runs,
    completeInBackground: completeSubagentRunInBackground,
  });

  return {
    pendingLifecycle,
    completeSubagentRunWithRecovery,
  };
}
