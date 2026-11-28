/** Observation only: the registry and Gateway still own continuation admission and execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentTurnFrame, AgentTurnIo } from "../../../gateway/agent-turn/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";

type AgentRpcYieldReply = NonNullable<AgentTurnIo["yieldReply"]>;
type Reply = {
  destination:
    | (Omit<AgentRpcYieldReply, "publish"> & { publish?: AgentRpcYieldReply["publish"] })
    | undefined;
  replay?: (frame: AgentTurnFrame) => void;
  originalRunId: string;
  sessionId: string;
  sessionKey: string;
  generation: ReturnType<typeof getAgentRunLifecycleGeneration>;
  close?: () => void;
};
type Execution = { reply: Reply; parked: boolean; successorStarted?: true };
type CohortMember = { execution: Execution; requesterRunId: string; generation: number };
const state = resolveGlobalSingleton(Symbol.for("openclaw.agentRpcYieldReply"), () => ({
  executions: new Map<string, Execution>(),
  cohorts: new WeakMap<object, CohortMember>(),
  successor: new AsyncLocalStorage<{ runId: string; execution: Execution }>(),
}));

export function promoteAgentRpcYieldReply(
  entries: readonly SubagentRunRecord[],
  runId: string,
  generation: number,
) {
  const execution = state.executions.get(runId);
  if (!execution?.reply.destination) {
    return;
  }
  const members = entries.filter(
    (entry) =>
      entry.requesterSessionKey === execution.reply.sessionKey &&
      entry.requesterSettleWake?.requesterRunId === runId &&
      entry.requesterSettleWake.rearmGeneration === generation,
  );
  if (members.length === 0) {
    return;
  }
  execution.parked = true;
  const owner = { execution, requesterRunId: runId, generation };
  for (const member of members) {
    state.cohorts.set(getSubagentRunRuntimeKey(member), owner);
  }
}

function readCohortExecution(entries: readonly SubagentRunRecord[]) {
  const first = entries[0];
  const owner = first && state.cohorts.get(getSubagentRunRuntimeKey(first));
  return owner &&
    entries.every(
      (entry) =>
        state.cohorts.get(getSubagentRunRuntimeKey(entry)) === owner &&
        entry.requesterSettleWake?.requesterRunId === owner.requesterRunId &&
        entry.requesterSettleWake.rearmGeneration === owner.generation,
    )
    ? owner.execution
    : undefined;
}

export function withAgentRpcYieldSuccessor<T>(
  entries: readonly SubagentRunRecord[],
  runId: string,
  run: () => T,
): T {
  const execution = readCohortExecution(entries);
  return execution ? state.successor.run({ runId, execution }, run) : run();
}

function closeReply(reply: Reply) {
  reply.destination = undefined;
  reply.replay = undefined;
  reply.close?.();
  reply.close = undefined;
}

function publishReply(reply: Reply, [ok, payload, error]: AgentTurnFrame) {
  const destination = reply.destination;
  const replay = reply.replay;
  closeReply(reply);
  if (reply.generation !== getAgentRunLifecycleGeneration()) {
    return;
  }
  const frame: AgentTurnFrame = [
    ok,
    payload && typeof payload === "object" ? { ...payload, runId: reply.originalRunId } : payload,
    error,
  ];
  replay?.(frame);
  if (!destination?.signal.aborted) {
    destination?.publish?.(frame, reply.originalRunId);
  }
}

/** A definitively retired wake never reached the execution's final-frame handler. */
export function finishUnstartedAgentRpcYieldSuccessor(entries: readonly SubagentRunRecord[]) {
  const execution = readCohortExecution(entries);
  if (!execution || execution.successorStarted) {
    return;
  }
  publishReply(execution.reply, [true, { status: "error", summary: "failed" }, undefined]);
}

export function observeAgentRpcYieldExecution(params: {
  runId: string;
  sessionId: string | undefined;
  sessionKey: string | undefined;
  yieldReply: AgentTurnIo["yieldReply"];
}) {
  const { runId, sessionId, sessionKey, yieldReply } = params;
  const successor = state.successor.getStore();
  const reply =
    successor?.runId === runId &&
    successor.execution.reply.sessionId === sessionId &&
    successor.execution.reply.sessionKey === sessionKey
      ? successor.execution.reply
      : yieldReply && sessionId && sessionKey
        ? {
            destination: { ...yieldReply },
            originalRunId: runId,
            sessionId,
            sessionKey,
            generation: getAgentRunLifecycleGeneration(),
          }
        : undefined;
  if (!reply?.destination || reply.generation !== getAgentRunLifecycleGeneration()) {
    return undefined;
  }
  if (successor?.execution.reply === reply) {
    successor.execution.successorStarted = true;
  }
  const execution: Execution = { reply, parked: false };
  state.executions.set(runId, execution);
  const release = () => {
    if (state.executions.get(runId) === execution) {
      state.executions.delete(runId);
    }
  };
  return {
    updateSessionId(nextSessionId: string) {
      reply.sessionId = nextSessionId;
    },
    retainReplay: (publish: (frame: AgentTurnFrame) => void) => {
      if (!execution.parked || reply.originalRunId !== runId) {
        return false;
      }
      reply.replay = publish;
      return true;
    },
    finish(frame: AgentTurnFrame) {
      release();
      const destination = reply.destination;
      const payload = asOptionalRecord(frame[1]);
      const result = asOptionalRecord(payload?.result);
      const parked =
        execution.parked &&
        frame[0] &&
        payload?.status === "ok" &&
        asOptionalRecord(result?.meta)?.yielded === true;
      if (!parked) {
        if (reply.originalRunId !== runId) {
          publishReply(reply, frame);
        } else {
          closeReply(reply);
        }
        return false;
      }
      if (destination && !reply.close) {
        const detach = () => {
          delete destination.publish;
        };
        if (destination.signal.aborted) {
          detach();
        }
        const timer = setTimeout(
          () => {
            publishReply(reply, [
              true,
              { status: "timeout", summary: "aborted", stopReason: "timeout" },
              undefined,
            ]);
          },
          Math.max(0, destination.deadline - Date.now()),
        );
        timer.unref();
        destination.signal.addEventListener("abort", detach, { once: true });
        reply.close = () => {
          clearTimeout(timer);
          destination.signal.removeEventListener("abort", detach);
        };
      }
      // Suppress only the parked RPC's physical frame; internal wake observers still need theirs.
      return reply.originalRunId === runId;
    },
    release,
  };
}
