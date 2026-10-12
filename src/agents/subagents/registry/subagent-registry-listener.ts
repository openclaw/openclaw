import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
  type AgentEventPayload,
} from "../../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { prepareSubagentTerminalObservation } from "./subagent-registry-completion-runtime.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createSubagentRegistryListener(config: {
  runs: Map<string, SubagentRunRecord>;
  pendingLifecycle: ReturnType<typeof createPendingLifecycleScheduler>;
  onAgentEvent: (listener: (event: AgentEventPayload) => void) => () => void;
  resumeRequesterSettleWake: (runId: string, entry: SubagentRunRecord) => void;
  adoptPausedSubagentRunIntoSuccessor: (entry: SubagentRunRecord) => Promise<boolean>;
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
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
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
        const terminalReply = normalizeAgentRunTerminalReplySnapshot(evt.data?.terminalReply);
        const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase,
          data: evt.data,
          startedAt,
          endedAt,
        });
        const completion = await prepareSubagentTerminalObservation({
          entry,
          terminal: terminalOutcome,
          // A lifecycle yield is authoritative for ordinary continuations, even
          // when the abort signal also reports timeout. Collectors need a result.
          yielded:
            evt.data?.yielded === true &&
            (!entry.collect ||
              (terminalOutcome.status !== "timeout" && terminalOutcome.reason !== "blocked")),
          terminalReply,
          runs,
          context,
          assertCurrent,
          clearPending: () => pendingLifecycle.clear(evt.runId),
          adoptPaused: config.adoptPausedSubagentRunIntoSuccessor,
          resumePaused: (paused) => config.resumeRequesterSettleWake(paused.runId, paused),
        });
        if (!completion) {
          return;
        }
        assertCurrent();
        const pendingTerminal = {
          runId: evt.runId,
          expectedEntry: completion.expectedEntry,
          endedAt,
          startedAt,
          terminalReply,
        };
        if (
          completion.reason === SUBAGENT_ENDED_REASON_KILLED &&
          evt.data?.aborted === true &&
          evt.data.stopReason === undefined &&
          evt.data.status === undefined &&
          evt.data.timeoutPhase === undefined
        ) {
          pendingLifecycle.scheduleCancellation(pendingTerminal);
          return;
        }
        if (completion.outcome.status === "timeout") {
          pendingLifecycle.scheduleTimeout(pendingTerminal);
          return;
        }
        if (phase === "error" && completion.reason === SUBAGENT_ENDED_REASON_ERROR) {
          pendingLifecycle.scheduleError({
            ...pendingTerminal,
            error: terminalOutcome.error,
          });
          return;
        }
        pendingLifecycle.clear(evt.runId);
        await completeSubagentRunWithRecovery(
          completion,
          `lifecycle-${terminalOutcome.reason}-event`,
        );
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
