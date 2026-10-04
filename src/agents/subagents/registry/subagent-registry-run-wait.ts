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
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { waitForAgentRun } from "../../run-wait.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import type { CleanupBookkeepingParams } from "./subagent-registry-lifecycle-context.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import type {
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = isFastTestRuntimeEnv() ? 25 : 5_000;
const WAIT_TIMEOUT_DEADLINE_SKEW_MS = 250;

function resolveHardRunTimeoutEndedAt(
  entry: SubagentRunRecord,
  now: number,
  observedStartedAt?: number,
): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  return now + WAIT_TIMEOUT_DEADLINE_SKEW_MS >= deadlineMs ? deadlineMs : undefined;
}

function resolveCompletionAfterHardRunDeadline(params: {
  entry: SubagentRunRecord;
  observedStartedAt?: number;
  observedEndedAt?: number;
  now: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  const observedEndedAt = asFiniteNumber(params.observedEndedAt) ?? params.now;
  return observedEndedAt > deadlineMs ? deadlineMs : undefined;
}

function resolveWaitTimeoutMsForRun(
  entry: SubagentRunRecord,
  waitTimeoutMs: number,
  now: number,
): number {
  const normalizedWaitTimeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
  const deadlineMs = resolveSubagentRunDeadlineMs(entry);
  if (deadlineMs === undefined) {
    return normalizedWaitTimeoutMs;
  }
  return Math.max(1, Math.min(normalizedWaitTimeoutMs, deadlineMs - now));
}

/** Return the admitted observation so delayed lifecycle classification retains its attempt. */
export async function preserveSubagentRunForRestart(params: {
  entry: SubagentRunRecord;
  terminal: AgentRunTerminalOutcome;
  runs: Map<string, SubagentRunRecord>;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<{ preserved: boolean; observedEntry: SubagentRunRecord }> {
  return mutateSubagentRuns(
    [params.entry.runId],
    (rows) => {
      const entry = rows.get(params.entry.runId);
      if (!entry || !isSameSubagentRunOwner(entry, params.entry)) {
        throw new Error("Subagent restart preservation lost its original run");
      }
      // A failed wait cannot replace a recorded interruption with an invented terminal.
      if (
        entry.execution.status === "interrupted" &&
        entry.execution.interruptionReason === "gateway-restart" &&
        params.terminal.endedAt === undefined &&
        (params.terminal.reason === "failed" || params.terminal.reason === "timed_out")
      ) {
        return { value: { preserved: true, observedEntry: entry } };
      }
      if (params.terminal.reason !== "cancelled" || params.terminal.stopReason !== "restart") {
        return { value: { preserved: false, observedEntry: entry } };
      }
      if (
        entry.execution.status === "terminal" ||
        typeof entry.execution.endedAt === "number" ||
        shouldSuppressSubagentRecoverySessionEffects(entry)
      ) {
        return { value: { preserved: true, observedEntry: entry } };
      }
      if (
        entry.killIntent ||
        entry.killReconciliation ||
        resolveCompletionAfterHardRunDeadline({
          entry,
          observedStartedAt: params.terminal.startedAt,
          observedEndedAt: params.terminal.endedAt,
          now: Date.now(),
        }) !== undefined
      ) {
        return { value: { preserved: false, observedEntry: entry } };
      }
      if (entry.execution.status === "interrupted") {
        return { value: { preserved: true, observedEntry: entry } };
      }
      return {
        value: { preserved: true, observedEntry: entry },
        postimages: new Map([
          [
            entry.runId,
            {
              ...entry,
              execution: {
                ...entry.execution,
                status: "interrupted" as const,
                interruptedAt: params.terminal.endedAt ?? Date.now(),
                interruptionReason: "gateway-restart" as const,
              },
            },
          ],
        ]),
      };
    },
    { runs: params.runs, context: params.context, assertCurrent: params.assertCurrent },
  );
}

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
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ): Promise<void> => {
    // A current Gateway may observe historical execution; the wait itself owns this generation.
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const stateContext = captureOpenClawStateWorkerContext();
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
      const scheduledEntry = entry;
      setTimeout(() => {
        const current = this.options.runs.get(runId);
        if (
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          !current ||
          !isSameSubagentRunOwner(current, scheduledEntry) ||
          typeof current.execution.endedAt === "number"
        ) {
          return;
        }
        void this.waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry, true);
      }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
      log.info(reason, {
        runId,
        childSessionKey: entry.childSessionKey,
        ...(error ? { error } : {}),
      });
    };
    try {
      const entryBeforeWait = this.options.runs.get(runId);
      if (
        !entryBeforeWait ||
        (expectedEntry && !isSameSubagentRunOwner(entryBeforeWait, expectedEntry))
      ) {
        return;
      }
      waitedEntry = entryBeforeWait;
      const waitStartedAt = Date.now();
      const timeoutMs = capWaitToStoredDeadline
        ? resolveWaitTimeoutMsForRun(entryBeforeWait, waitTimeoutMs, waitStartedAt)
        : Math.max(1, Math.floor(waitTimeoutMs));
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
      if (wait.status === "pending") {
        return;
      }
      // Reconciliation can yield to worker IO before the terminal owner takes custody.
      releaseCompletionWork = retainGatewayRootWorkAdmissionContinuation();
      const waitTerminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(wait);
      const waitBlocked = waitTerminalOutcome?.reason === "blocked";
      const waitAborted =
        waitTerminalOutcome !== undefined &&
        classifySubagentTerminalOutcome(waitTerminalOutcome) === "cancellation";
      const waitStatus = waitTerminalOutcome?.status ?? wait.status;
      const complete = (
        completion: Omit<
          SubagentCompletionRequest,
          "runId" | "expectedEntry" | "sendFarewell" | "accountId" | "triggerCleanup"
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
      if (wait.yielded === true && waitStatus !== "timeout" && !waitBlocked) {
        if (entry.collect !== true) {
          await mutateSubagentRuns(
            [runId],
            (rows) => {
              const current = rows.get(runId);
              if (!current || !isSameSubagentRunOwner(current, waitedEntry)) {
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
                  startedAt: wait.startedAt,
                  endedAt: wait.endedAt,
                })
                  ? { postimages: new Map([[runId, draft]]) }
                  : {}),
              };
            },
            { runs: this.options.runs, context: stateContext, assertCurrent },
          );
          assertCurrent();
          const paused = this.options.runs.get(runId);
          if (paused?.pauseReason === "sessions_yield") {
            this.options.clearPendingLifecycleError(runId);
            this.options.clearPendingLifecycleTimeout(runId);
            if (
              await this.adoptPausedSubagentRunIntoSuccessor({
                childSessionKey: paused.childSessionKey,
                childAgentId: paused.childAgentId,
              })
            ) {
              return;
            }
            if (paused.requesterSettleWake?.pauseNotice) {
              this.options.resumedRuns.delete(getSubagentRunRuntimeKey(paused));
              this.options.resumeSubagentRun(runId);
            }
          }
          return;
        }
        this.options.clearPendingLifecycleError(runId);
        this.options.clearPendingLifecycleTimeout(runId);
        // A collector result is read by an explicit wait and never delivered by a
        // requester continuation, so nothing can resume a parked collector and its
        // waiter blocks for good. The attempt's own terminal is the only result
        // this run will ever have: settle it as the ordinary success it is, which
        // freezes the collector completion the waiter reads.
        await complete({
          endedAt: typeof wait.endedAt === "number" ? wait.endedAt : Date.now(),
          outcome: { status: "ok" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          terminalReply: wait.terminalReply,
          ...(typeof wait.startedAt === "number" && Number.isFinite(wait.startedAt)
            ? { startedAt: wait.startedAt }
            : {}),
        });
        return;
      }
      if (
        waitTerminalOutcome &&
        (
          await preserveSubagentRunForRestart({
            entry,
            terminal: waitTerminalOutcome,
            runs: this.options.runs,
            context: stateContext,
            assertCurrent,
          })
        ).preserved
      ) {
        this.options.clearPendingLifecycleError(runId);
        this.options.clearPendingLifecycleTimeout(runId);
        return;
      }
      entry = currentEntry();
      if (waitStatus === "error" && !waitAborted && wait.retryableTransportError) {
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
      if (waitStatus === "timeout") {
        const isTerminalWaitTimeout =
          typeof wait.endedAt === "number" ||
          typeof wait.stopReason === "string" ||
          typeof wait.livenessState === "string";
        const now = Date.now();
        // A plain agent.wait timeout has no terminal snapshot. For explicit
        // subagent run timeouts, the stored run deadline is the completion
        // contract so parent sessions are woken instead of retrying forever.
        const hardRunTimeoutEndedAt = resolveHardRunTimeoutEndedAt(entry, now, observedStartedAt);
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
          const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt: completionStartedAt,
            observedEndedAt: completion.endedAt,
            now,
          });
          if (completionAfterDeadline !== undefined) {
            await completeAsRunTimeout(completionAfterDeadline, completionStartedAt);
            return;
          }
          await complete({
            endedAt: completion.endedAt,
            outcome: completion.outcome,
            reason: completion.reason,
            startedAt: completionStartedAt,
          });
          return;
        }
        if (isTerminalWaitTimeout || hardRunTimeoutEndedAt !== undefined) {
          let timeoutEndedAt =
            typeof wait.endedAt === "number" ? wait.endedAt : hardRunTimeoutEndedAt;
          const timeoutAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt,
            observedEndedAt: timeoutEndedAt,
            now,
          });
          if (timeoutAfterDeadline !== undefined) {
            timeoutEndedAt = timeoutAfterDeadline;
          }
          await completeAsRunTimeout(timeoutEndedAt, observedStartedAt);
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
      const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
        entry,
        observedStartedAt,
        observedEndedAt: wait.endedAt,
        now: Date.now(),
      });
      if (completionAfterDeadline !== undefined) {
        await completeAsRunTimeout(completionAfterDeadline, observedStartedAt);
        return;
      }
      const endedAt = typeof wait.endedAt === "number" ? wait.endedAt : Date.now();
      const rawWaitError = typeof wait.error === "string" ? wait.error : undefined;
      const waitError = waitAborted
        ? "subagent run terminated"
        : (waitTerminalOutcome?.error ?? rawWaitError);
      const baseOutcome: SubagentRunOutcome =
        waitStatus === "error" ? { status: "error", error: waitError } : { status: "ok" };
      const outcome = withSubagentOutcomeTiming(baseOutcome, {
        startedAt: observedStartedAt ?? entry.execution.startedAt,
        endedAt,
      });
      await complete({
        endedAt,
        outcome,
        reason: waitAborted
          ? SUBAGENT_ENDED_REASON_KILLED
          : waitStatus === "error"
            ? SUBAGENT_ENDED_REASON_ERROR
            : SUBAGENT_ENDED_REASON_COMPLETE,
        startedAt: observedStartedAt,
        terminalReply: wait.terminalReply,
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
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ): Promise<void> =>
    runWithoutOwnedSessionTranscriptWrites(() =>
      this.runSubagentCompletionWait(runId, waitTimeoutMs, expectedEntry, capWaitToStoredDeadline),
    );
}
