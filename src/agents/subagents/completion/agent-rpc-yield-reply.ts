/** Observation only: the registry and Gateway still own continuation admission and execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureSessionEntryView } from "../../../config/sessions/session-entry-view.js";
import type { AgentTurnFrame, AgentTurnIo } from "../../../gateway/agent-turn/types.js";
import { registerAgentEventLifecycleRotationHandler } from "../../../infra/agent-events.js";
import type { ChatRef } from "../../../sessions/chat-ref.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.contracts.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isRequesterYieldCohortMember } from "../registry/subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";

type AgentRpcYieldReply = NonNullable<AgentTurnIo["yieldReply"]>;
type EntryView = Parameters<typeof captureSessionEntryView>[0];
const TRANSCRIPT_FIELDS = ["sessionId", "lifecycleRevision"] as const;

type Reply = {
  destination:
    | (Omit<AgentRpcYieldReply, "publish"> & { publish?: AgentRpcYieldReply["publish"] })
    | undefined;
  replay?: (frame: AgentTurnFrame) => void;
  address: ChatRef;
  transcript: ReturnType<typeof captureSessionEntryView>;
  close?: () => void;
};
type Execution = { reply: Reply; parked: boolean; successorStarted?: true };
type CohortMember = {
  execution: Execution;
  wake: NonNullable<SubagentRunRecord["requesterSettleWake"]>;
};
const state = resolveGlobalSingleton(Symbol.for("openclaw.agentRpcYieldReply"), () => ({
  executions: new WeakMap<SessionControllerInput, Execution>(),
  replies: new Set<Reply>(),
  cohorts: new WeakMap<object, CohortMember>(),
  successor: new AsyncLocalStorage<{ input: SessionControllerInput; execution: Execution }>(),
}));

/** The committed registry transfer supplies its already-selected child cohort. */
export function promoteAgentRpcYieldReply(
  entries: readonly SubagentRunRecord[],
  input: SessionControllerInput,
) {
  const execution = state.executions.get(input);
  const wake = entries[0]?.requesterSettleWake;
  if (!execution?.reply.destination || !wake?.batchRunIds) {
    return;
  }
  execution.parked = true;
  const owner = { execution, wake };
  for (const member of entries) {
    state.cohorts.set(getSubagentRunRuntimeKey(member), owner);
  }
}

function readCohortExecution(entries: readonly SubagentRunRecord[]) {
  const first = entries[0];
  const owner = first && state.cohorts.get(getSubagentRunRuntimeKey(first));
  const batch = owner?.wake.batchRunIds;
  return owner &&
    batch &&
    entries.every(
      (entry) =>
        state.cohorts.get(getSubagentRunRuntimeKey(entry)) === owner &&
        isRequesterYieldCohortMember(entry, batch, owner.wake.rearmGeneration),
    )
    ? owner.execution
    : undefined;
}

export function withAgentRpcYieldSuccessor<T>(
  entries: readonly SubagentRunRecord[],
  input: SessionControllerInput,
  run: () => T,
): T {
  const execution = readCohortExecution(entries);
  return execution ? state.successor.run({ input, execution }, run) : run();
}

function closeReply(reply: Reply) {
  state.replies.delete(reply);
  reply.destination = undefined;
  reply.replay = undefined;
  reply.close?.();
  reply.close = undefined;
}

registerAgentEventLifecycleRotationHandler("subagent-rpc-yield-replies", () => {
  for (const reply of state.replies) {
    closeReply(reply);
  }
});

function publishReply(reply: Reply, frame: AgentTurnFrame) {
  const destination = reply.destination;
  const replay = reply.replay;
  closeReply(reply);
  if (!destination) {
    return;
  }
  const projected = destination.project(frame);
  replay?.(projected);
  if (!destination.signal.aborted) {
    destination.publish?.(projected);
  }
}

/** A definitively retired wake never reached the execution's final-frame handler. */
export function finishUnstartedAgentRpcYieldSuccessor(entries: readonly SubagentRunRecord[]) {
  const execution = readCohortExecution(entries);
  if (!execution || execution.successorStarted) {
    return;
  }
  publishReply(execution.reply, [
    true,
    {
      status: "error",
      summary:
        "The continuation was retired before it could start. Check the child results saved in the session before retrying.",
    },
    undefined,
  ]);
}

export function observeAgentRpcYieldExecution(params: {
  input: SessionControllerInput | undefined;
  address: ChatRef | undefined;
  entry: EntryView;
  yieldReply: AgentTurnIo["yieldReply"];
}) {
  const { input, address, entry, yieldReply } = params;
  if (!input || !address) {
    return undefined;
  }
  const successor = state.successor.getStore();
  const inherited = successor?.input === input ? successor.execution : undefined;
  const original = !inherited;
  const reply: Reply | undefined =
    inherited?.reply ??
    (yieldReply
      ? {
          destination: { ...yieldReply },
          address,
          transcript: captureSessionEntryView(entry, TRANSCRIPT_FIELDS),
        }
      : undefined);
  if (
    !reply?.destination ||
    reply.address.sessionKey !== address.sessionKey ||
    reply.address.agentId !== address.agentId ||
    reply.address.storePath !== address.storePath ||
    !reply.transcript.matches(entry)
  ) {
    return undefined;
  }
  if (inherited) {
    inherited.successorStarted = true;
  } else {
    state.replies.add(reply);
  }
  const execution: Execution = { reply, parked: false };
  state.executions.set(input, execution);
  const release = () => {
    if (state.executions.get(input) === execution) {
      state.executions.delete(input);
      if (original && !reply.close) {
        closeReply(reply);
      }
    }
  };
  return {
    adoptTranscript(next: EntryView) {
      reply.transcript = captureSessionEntryView(next, TRANSCRIPT_FIELDS);
    },
    retainReplay: (publish: (frame: AgentTurnFrame) => void) => {
      if (!execution.parked || !original) {
        return false;
      }
      reply.replay = publish;
      return true;
    },
    finish(frame: AgentTurnFrame) {
      const destination = reply.destination;
      const payload = asOptionalRecord(frame[1]);
      const result = asOptionalRecord(payload?.result);
      const parked =
        execution.parked &&
        frame[0] &&
        payload?.status === "ok" &&
        asOptionalRecord(result?.meta)?.yielded === true;
      if (!parked) {
        if (!original) {
          publishReply(reply, frame);
        } else {
          closeReply(reply);
        }
        release();
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
      release();
      // Suppress only the parked RPC's physical frame; internal wake observers still need theirs.
      return original;
    },
    release,
  };
}
