import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
  type AgentEventPayload,
} from "../../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { preserveSubagentRunForRestart } from "./subagent-registry-run-manager.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createSubagentRegistryListener(config: {
  runs: Map<string, SubagentRunRecord>;
  pendingLifecycle: ReturnType<typeof createPendingLifecycleScheduler>;
  onAgentEvent: (listener: (event: AgentEventPayload) => void) => () => void;
  resumeRequesterSettleWake: (runId: string, entry: SubagentRunRecord) => void;
  refreshFrozenResultFromSession: (sessionKey: string) => Promise<unknown>;
  completeSubagentRunWithRecovery: (
    params: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    pendingLifecycle,
    onAgentEvent,
    refreshFrozenResultFromSession,
    completeSubagentRunWithRecovery,
    warn,
  } = config;
  let listenerStop: (() => void) | null = null;

  function ensureListener() {
    if (listenerStop) {
      return;
    }
    listenerStop = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      // Own lifecycle writes before their first await, including restart preservation.
      void runWithGatewayIndependentRootWorkContinuation(async () => {
        const phase = evt.data?.phase;
        const entry = runs.get(evt.runId);
        if (!entry) {
          if (phase === "end" && typeof evt.sessionKey === "string") {
            const sessionKey = evt.sessionKey;
            // A replacement generation can finish after its predecessor row is terminal.
            await refreshFrozenResultFromSession(sessionKey);
          }
          return;
        }
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const context = captureOpenClawStateWorkerContext();
        const assertCurrent = () => {
          assertSubagentRegistryWriteSourceCurrent(context);
          if (
            !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
            !isSameSubagentRunOwner(runs.get(evt.runId), entry)
          ) {
            throw new Error("Subagent lifecycle event lost its original run");
          }
        };
        if (phase === "start") {
          const startedAt =
            typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
          if (startedAt) {
            await mutateSubagentRuns(
              [evt.runId],
              (rows) => {
                const current = rows.get(evt.runId);
                if (!current || !isSameSubagentRunOwner(current, entry)) {
                  throw new Error("Subagent lifecycle start lost its original run");
                }
                if (
                  current.execution.status === "terminal" ||
                  current.killIntent ||
                  current.killReconciliation ||
                  shouldSuppressSubagentRecoverySessionEffects(current) ||
                  (current.execution.status === "running" &&
                    current.execution.startedAt === startedAt &&
                    typeof current.sessionStartedAt === "number")
                ) {
                  return { value: undefined };
                }
                return {
                  value: undefined,
                  postimages: new Map([
                    [
                      evt.runId,
                      {
                        ...current,
                        sessionStartedAt: current.sessionStartedAt ?? startedAt,
                        execution: { ...current.execution, status: "running" as const, startedAt },
                      },
                    ],
                  ]),
                };
              },
              { runs, context, assertCurrent },
            );
          }
          assertCurrent();
          pendingLifecycle.clearPriorAttempt(evt.runId);
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        const terminalReply = normalizeAgentRunTerminalReplySnapshot(evt.data?.terminalReply);
        const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase,
          data: evt.data,
          startedAt,
          endedAt,
        });
        const complete = (
          outcome: SubagentCompletionRequest["outcome"],
          reason: SubagentCompletionRequest["reason"],
          source: string,
        ) =>
          completeSubagentRunWithRecovery(
            {
              runId: evt.runId,
              expectedEntry: entry,
              endedAt,
              outcome,
              reason,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
              startedAt,
              terminalReply,
            },
            source,
          );
        // sessions_yield ends the turn by aborting the run signal, so a yielded
        // terminal can also look aborted. An explicit yield is authoritative — pause,
        // don't kill — else the tracking task settles `cancelled` with a false notice (#92448).
        // Match the wait observer for collectors: an outer timeout or blocked
        // outcome can coexist with yield metadata and must not become success.
        // Ordinary yielded continuations retain their existing pause contract.
        if (
          evt.data?.yielded === true &&
          (entry.collect !== true ||
            (terminalOutcome.status !== "timeout" && terminalOutcome.reason !== "blocked"))
        ) {
          if (entry.collect !== true) {
            await mutateSubagentRuns(
              [evt.runId],
              (rows) => {
                const current = rows.get(evt.runId);
                if (!current || !isSameSubagentRunOwner(current, entry)) {
                  throw new Error("Subagent lifecycle yield lost its original run");
                }
                if (current.collect || current.killIntent || current.killReconciliation) {
                  return { value: undefined };
                }
                const draft = structuredClone(current);
                return {
                  value: undefined,
                  ...(markSubagentRunPausedAfterYield({
                    entry: draft,
                    endedAt,
                    startedAt: startedAt ?? current.execution.startedAt,
                  })
                    ? { postimages: new Map([[evt.runId, draft]]) }
                    : {}),
                };
              },
              { runs, context, assertCurrent },
            );
            assertCurrent();
            const paused = runs.get(evt.runId);
            if (paused?.pauseReason === "sessions_yield") {
              // An earlier event can arm grace while this row's publication awaits its ACK.
              pendingLifecycle.clear(evt.runId);
              if (paused.requesterSettleWake?.pauseNotice) {
                config.resumeRequesterSettleWake(paused.runId, paused);
              }
            }
            return;
          }
          pendingLifecycle.clear(evt.runId);
          // A collector result is read by an explicit wait and never delivered by
          // a requester continuation, so nothing can resume a parked collector and
          // its waiter blocks for good. The attempt's own terminal is the only
          // result this run will ever have: settle it as the ordinary success it
          // is, which freezes the collector completion the waiter reads.
          await complete(
            { status: "ok" },
            SUBAGENT_ENDED_REASON_COMPLETE,
            "lifecycle-collector-yield-event",
          );
          return;
        }
        const preservation = await preserveSubagentRunForRestart({
          entry,
          terminal: terminalOutcome,
          runs,
          context,
          assertCurrent,
        });
        if (preservation.preserved) {
          pendingLifecycle.clear(evt.runId);
          return;
        }
        assertCurrent();
        const classification = classifySubagentTerminalOutcome(terminalOutcome);
        const pendingTerminal = {
          runId: evt.runId,
          expectedEntry: preservation.observedEntry,
          endedAt,
          startedAt,
          terminalReply,
        };
        if (
          classification === "cancellation" &&
          evt.data?.aborted === true &&
          evt.data.stopReason === undefined &&
          evt.data.status === undefined &&
          evt.data.timeoutPhase === undefined
        ) {
          pendingLifecycle.scheduleCancellation(pendingTerminal);
          return;
        }
        if (classification === "timeout") {
          pendingLifecycle.scheduleTimeout(pendingTerminal);
          return;
        }
        if (phase === "error" && classification === "failure") {
          pendingLifecycle.scheduleError({
            ...pendingTerminal,
            error: terminalOutcome.error,
          });
          return;
        }
        if (classification !== "success") {
          const cancelled = classification === "cancellation";
          pendingLifecycle.clear(evt.runId);
          await complete(
            {
              status: "error",
              error: cancelled ? "subagent run terminated" : terminalOutcome.error,
            },
            cancelled ? SUBAGENT_ENDED_REASON_KILLED : SUBAGENT_ENDED_REASON_ERROR,
            cancelled ? "lifecycle-killed-event" : `lifecycle-${terminalOutcome.reason}-event`,
          );
          return;
        }
        pendingLifecycle.clear(evt.runId);
        await complete({ status: "ok" }, SUBAGENT_ENDED_REASON_COMPLETE, "lifecycle-ok-event");
      }, "subagents:lifecycle-event").catch((err: unknown) => {
        warn("lifecycle event handler failed", { err, runId: evt.runId });
      });
    });
  }

  return {
    ensure: ensureListener,
    reset: () => {
      if (listenerStop) {
        listenerStop();
        listenerStop = null;
      }
    },
  };
}
