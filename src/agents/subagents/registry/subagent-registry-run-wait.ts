import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { waitForAgentRun } from "../../run-wait.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { prepareSubagentTerminalObservation } from "./subagent-registry-completion-runtime.js";
import type { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import type { CleanupBookkeepingParams } from "./subagent-registry-lifecycle-context.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";
import {
  resolveCompletionAfterHardRunDeadline,
  resolveSubagentRunDeadlineMs,
} from "./subagent-run-timeout.js";
import type {
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = isFastTestRuntimeEnv() ? 25 : 5_000;
const WAIT_TIMEOUT_DEADLINE_SKEW_MS = 250;

export type SubagentManagerOptions = {
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  resumedRuns: Set<object>;
  acquireTerminalCompletionLock: (runId: string) => Promise<() => void>;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  clearPendingLifecycleTimeout(runId: string): void;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  scheduleSweep(args?: { delayMs?: number }): void;
  resolveSubagentSessionCompletion: typeof resolveSubagentSessionCompletion;
  resolveSubagentSessionStartedAt: typeof resolveSubagentSessionStartedAt;
  notifyContextEngineSubagentEnded: ReturnType<
    typeof createSubagentRegistryContextCleanup
  >["notifyContextEngineSubagentEnded"];
  completeCleanupBookkeeping(args: CleanupBookkeepingParams): Promise<void>;
  completeSubagentRun(args: SubagentCompletionRequest): Promise<void>;
};

export abstract class SubagentWaitManager {
  constructor(protected readonly options: SubagentManagerOptions) {}

  protected abstract readonly adoptPausedSubagentRunIntoSuccessor: (params: {
    childSessionKey: string;
    childAgentId?: string;
    assertCurrent?: () => void;
  }) => Promise<boolean>;

  protected currentRunOwnsSession(entry: SubagentRunRecord): boolean {
    const current = this.options.runs.get(entry.runId);
    return (
      current !== undefined &&
      isSameSubagentRunOwner(current, entry) &&
      current.killReconciliation?.supersededAt === undefined &&
      !Array.from(
        this.options.getRunsForChildSession(current.childSessionKey, current.childAgentId),
      ).some((candidate) => compareSubagentRunGeneration(candidate, current) > 0)
    );
  }

  private runSubagentCompletionWait = async (
    runId: string,
    expectedEntry: SubagentRunRecord,
    waitTimeoutMs: number,
    stateContext: OpenClawStateWorkerContext,
    lifecycleGeneration: string,
    capWaitToStoredDeadline = false,
  ): Promise<void> => {
    let waitedEntry: SubagentRunRecord | undefined;
    let completionAttempted = false;
    let releaseCompletionWork: (() => void) | null = null;
    const currentEntry = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = this.options.runs.get(runId);
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !current ||
        !isSameSubagentRunOwner(current, waitedEntry)
      ) {
        throw new Error("Subagent completion wait lost its original owner");
      }
      return current;
    };
    const assertCurrent = () => {
      currentEntry();
    };
    const scheduleWaitRetry = (entry: SubagentRunRecord, reason: string, error?: string) => {
      this.options.scheduleSweep({ delayMs: 1_000 });
      setTimeout(() => {
        const current = this.options.runs.get(runId);
        if (
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          !current ||
          !isSameSubagentRunOwner(current, entry) ||
          typeof current.execution.endedAt === "number"
        ) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          // Closing the original store retires this retry, even if the run is still resident.
          return;
        }
        void this.waitForSubagentCompletion(runId, entry, waitTimeoutMs, true);
      }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
      log.info(reason, {
        runId,
        childSessionKey: entry.childSessionKey,
        ...(error ? { error } : {}),
      });
    };
    try {
      const entryBeforeWait = this.options.runs.get(runId);
      if (!entryBeforeWait || !isSameSubagentRunOwner(entryBeforeWait, expectedEntry)) {
        return;
      }
      waitedEntry = entryBeforeWait;
      const waitStartedAt = Date.now();
      const normalizedWaitTimeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
      const deadlineMs = capWaitToStoredDeadline
        ? resolveSubagentRunDeadlineMs(entryBeforeWait)
        : undefined;
      const timeoutMs =
        deadlineMs === undefined
          ? normalizedWaitTimeoutMs
          : Math.max(1, Math.min(normalizedWaitTimeoutMs, deadlineMs - waitStartedAt));
      const wait = await waitForAgentRun({
        runId,
        timeoutMs,
        callGateway: this.options.callGateway,
      });
      // In-process restart never retains the old wait owner's authority.
      if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        return;
      }
      const observedEntry = this.options.runs.get(runId);
      if (!observedEntry || !isSameSubagentRunOwner(observedEntry, waitedEntry)) {
        return;
      }
      let entry: SubagentRunRecord = observedEntry;
      const waitTerminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(wait);
      if (!waitTerminalOutcome) {
        return;
      }
      // Reconciliation can yield to worker IO before the terminal owner takes custody.
      releaseCompletionWork = retainGatewayRootWorkAdmissionContinuation();
      const waitStatus = waitTerminalOutcome.status;
      const yielded =
        wait.yielded === true &&
        waitStatus !== "timeout" &&
        waitTerminalOutcome.reason !== "blocked";
      const observedCompletion = await prepareSubagentTerminalObservation({
        entry,
        terminal: waitTerminalOutcome,
        yielded,
        terminalReply: wait.terminalReply,
        runs: this.options.runs,
        context: stateContext,
        assertCurrent,
        clearPending: () => {
          this.options.clearPendingLifecycleError(runId);
          this.options.clearPendingLifecycleTimeout(runId);
        },
        adoptPaused: (paused) =>
          this.adoptPausedSubagentRunIntoSuccessor({
            childSessionKey: paused.childSessionKey,
            childAgentId: paused.childAgentId,
          }),
        resumePaused: (paused) => {
          this.options.resumedRuns.delete(getSubagentRunRuntimeKey(paused));
          this.options.resumeSubagentRun(runId);
        },
      });
      if (!observedCompletion) {
        return;
      }
      entry = currentEntry();
      const complete = (
        completion: Pick<
          SubagentCompletionRequest,
          "outcome" | "reason" | "endedAt" | "startedAt" | "terminalReply"
        >,
      ) => {
        completionAttempted = true;
        return this.options.completeSubagentRun({
          runId,
          expectedEntry: entry,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          ...completion,
        });
      };
      if (yielded) {
        await complete(observedCompletion);
        return;
      }
      if (
        waitStatus === "error" &&
        observedCompletion.reason !== SUBAGENT_ENDED_REASON_KILLED &&
        wait.retryableTransportError
      ) {
        scheduleWaitRetry(entry, "subagent wait interrupted; scheduling recovery", wait.error);
        return;
      }
      const observedStartedAt =
        asFiniteNumber(wait.startedAt) ??
        (await this.options.resolveSubagentSessionStartedAt({
          childSessionKey: entry.childSessionKey,
          childAgentId: entry.childAgentId,
          notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
          assertCurrent,
        }));
      entry = currentEntry();
      const completeAsRunTimeout = (endedAt?: number, startedAt?: number) =>
        complete({
          outcome: { status: "timeout" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          terminalReply: wait.terminalReply,
          ...(typeof endedAt === "number" ? { endedAt } : {}),
          ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
        });
      const completeWithDeadline = (
        startedAt: number | undefined,
        endedAt: number | undefined,
        now: number,
        fallback: () => Promise<void>,
      ) => {
        const timeoutAt = resolveCompletionAfterHardRunDeadline({
          entry,
          observedStartedAt: startedAt,
          observedEndedAt: endedAt,
          now,
        });
        return timeoutAt === undefined ? fallback() : completeAsRunTimeout(timeoutAt, startedAt);
      };
      if (waitStatus === "timeout") {
        const isTerminalWaitTimeout =
          typeof wait.endedAt === "number" ||
          typeof wait.stopReason === "string" ||
          typeof wait.livenessState === "string";
        const now = Date.now();
        // A plain agent.wait timeout has no terminal snapshot. For explicit
        // subagent run timeouts, the stored run deadline is the completion
        // contract so parent sessions are woken instead of retrying forever.
        const hardDeadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
        const hardRunTimeoutEndedAt =
          hardDeadlineMs !== undefined && now + WAIT_TIMEOUT_DEADLINE_SKEW_MS >= hardDeadlineMs
            ? hardDeadlineMs
            : undefined;
        const completion = await this.options.resolveSubagentSessionCompletion({
          childSessionKey: entry.childSessionKey,
          childAgentId: entry.childAgentId,
          fallbackEndedAt:
            typeof wait.endedAt === "number" ? wait.endedAt : (hardRunTimeoutEndedAt ?? now),
          notBeforeMs: observedStartedAt ?? entry.execution.startedAt ?? entry.createdAt,
          assertCurrent,
        });
        entry = currentEntry();
        if (completion) {
          const completionStartedAt = observedStartedAt ?? completion.startedAt;
          await completeWithDeadline(completionStartedAt, completion.endedAt, now, () =>
            complete({
              endedAt: completion.endedAt,
              outcome: completion.outcome,
              reason: completion.reason,
              startedAt: completionStartedAt,
            }),
          );
          return;
        }
        if (isTerminalWaitTimeout || hardRunTimeoutEndedAt !== undefined) {
          const timeoutEndedAt =
            typeof wait.endedAt === "number" ? wait.endedAt : hardRunTimeoutEndedAt;
          await completeWithDeadline(observedStartedAt, timeoutEndedAt, now, () =>
            completeAsRunTimeout(timeoutEndedAt, observedStartedAt),
          );
          return;
        }
        if (observedStartedAt !== undefined) {
          await mutateSubagentRuns(
            [runId],
            (rows) => {
              const current = rows.get(runId);
              if (!current || !isSameSubagentRunOwner(current, waitedEntry)) {
                throw new Error("Subagent wait reconciliation lost its original run");
              }
              if (
                typeof current.execution.endedAt === "number" ||
                current.killIntent ||
                current.killReconciliation ||
                current.execution.startedAt === observedStartedAt
              ) {
                return { value: undefined };
              }
              return {
                value: undefined,
                postimages: new Map([
                  [
                    runId,
                    {
                      ...current,
                      execution: { ...current.execution, startedAt: observedStartedAt },
                      sessionStartedAt: current.sessionStartedAt ?? observedStartedAt,
                    },
                  ],
                ]),
              };
            },
            { runs: this.options.runs, context: stateContext, assertCurrent },
          );
          assertCurrent();
        }
        scheduleWaitRetry(
          entry,
          "subagent wait timed out; deferring terminal state until session reconciliation",
        );
        return;
      }
      await completeWithDeadline(observedStartedAt, wait.endedAt, Date.now(), () => {
        const endedAt = typeof wait.endedAt === "number" ? wait.endedAt : Date.now();
        return complete({
          endedAt,
          outcome: withSubagentOutcomeTiming(observedCompletion.outcome, {
            startedAt: observedStartedAt ?? entry.execution.startedAt,
            endedAt,
          }),
          reason: observedCompletion.reason,
          startedAt: observedStartedAt,
          terminalReply: wait.terminalReply,
        });
      });
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        return;
      }
      let current = this.options.runs.get(runId);
      if (!current || !isSameSubagentRunOwner(current, waitedEntry)) {
        return;
      }
      assertCurrent();
      log.warn("subagent completion wait failed; recovering ended cleanup", {
        runId,
        childSessionKey: current.childSessionKey,
        error,
      });
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !isSameSubagentRunOwner(this.options.runs.get(runId), current)
      ) {
        return;
      }
      current = currentEntry();
      if (
        typeof current.execution.endedAt === "number" &&
        !current.cleanupCompletedAt &&
        current.pauseReason !== "sessions_yield"
      ) {
        const resume = await mutateSubagentRuns(
          [runId],
          (rows) => {
            const latest = rows.get(runId);
            if (!latest || !isSameSubagentRunOwner(latest, waitedEntry)) {
              throw new Error("Subagent cleanup retry lost its original run", { cause: error });
            }
            if (
              typeof latest.execution.endedAt !== "number" ||
              latest.cleanupCompletedAt ||
              latest.pauseReason === "sessions_yield"
            ) {
              return { value: false };
            }
            return {
              value: true,
              ...(latest.cleanupHandled === false
                ? {}
                : {
                    postimages: new Map([[runId, { ...latest, cleanupHandled: false }]]),
                  }),
            };
          },
          { runs: this.options.runs, context: stateContext, assertCurrent },
        );
        if (resume) {
          assertCurrent();
          this.options.resumedRuns.delete(getSubagentRunRuntimeKey(current));
          this.options.resumeSubagentRun(runId);
        }
      } else if (completionAttempted && typeof current.execution.endedAt !== "number") {
        this.options.scheduleSweep({ delayMs: 1_000 });
      }
    } finally {
      releaseCompletionWork?.();
    }
  };

  // Child completion outlives the spawning attempt, so all launch and retry
  // paths must start without inheriting its soon-to-be-disposed writer.
  readonly waitForSubagentCompletion = (
    runId: string,
    expectedEntry: SubagentRunRecord,
    waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(
      this.options.getRuntimeConfig(),
      expectedEntry.runTimeoutSeconds,
    ),
    capWaitToStoredDeadline = false,
  ): Promise<void> => {
    const waiting = runWithoutOwnedSessionTranscriptWrites(async () => {
      // A current Gateway may observe historical execution; the wait owns this generation.
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const stateContext = captureOpenClawStateWorkerContext();
      try {
        await this.runSubagentCompletionWait(
          runId,
          expectedEntry,
          waitTimeoutMs,
          stateContext,
          lifecycleGeneration,
          capWaitToStoredDeadline,
        );
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        // Recovery also awaits writes, so its original owner can retire after the first failure.
        if (
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          !isSameSubagentRunOwner(this.options.runs.get(runId), expectedEntry)
        ) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          return;
        }
        throw error;
      }
    });
    // Detached launches report failures; awaited callers still receive the original rejection.
    void waiting.catch((error: unknown) => {
      log.warn("subagent completion wait recovery failed", { runId, error });
    });
    return waiting;
  };
}
