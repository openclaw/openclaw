import { afterEach, expect, it, vi } from "vitest";
import type { AgentTurnFrame } from "../../../gateway/agent-turn/types.js";
import { chatRef } from "../../../sessions/chat-ref.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  finishUnstartedAgentRpcYieldSuccessor,
  observeAgentRpcYieldExecution,
  promoteAgentRpcYieldReply,
  withAgentRpcYieldSuccessor,
} from "./agent-rpc-yield-reply.js";

const address = chatRef({
  sessionKey: "agent:main:requester",
  agentId: "main",
  storePath: "/fixture/sessions.json",
});
const session = { sessionId: "requester-session", lifecycleRevision: "initial" };
const sources: ReturnType<typeof reserveSessionControllerSource>[] = [];
function reserve() {
  const input = reserveSessionControllerSource(address.sessionKey, {
    policy: { mode: "followup" },
  });
  sources.push(input);
  return input;
}
function project([ok, payload, error]: AgentTurnFrame): AgentTurnFrame {
  return [
    ok,
    { ...(typeof payload === "object" && payload !== null ? payload : {}), runId: "original" },
    error,
  ];
}
const yielded = [true, { status: "ok", result: { meta: { yielded: true } } }, undefined] as const;
const final = [
  true,
  { status: "ok", result: { payloads: [{ text: "final" }] } },
  undefined,
] as const;

function cohort(runId: string): SubagentRunRecord[] {
  return [
    {
      runId: "child-of-" + runId,
      childSessionKey: "agent:main:child-of-" + runId,
      requesterSessionKey: address.sessionKey,
      requesterDisplayKey: address.sessionKey,
      task: "child task",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterRunId: runId,
        rearmGeneration: 1,
        requesterYieldBatch: true,
        batchRunIds: ["child-of-" + runId],
      },
    },
  ];
}

function parkOriginal(compactedSessionId?: string) {
  vi.useFakeTimers();
  const publish = vi.fn();
  const replay = vi.fn();
  const controller = new AbortController();
  const input = reserve();
  const initial = observeAgentRpcYieldExecution({
    address,
    entry: session,
    input,
    yieldReply: { signal: controller.signal, deadline: Date.now() + 1000, publish, project },
  })!;
  if (compactedSessionId) {
    initial.adoptTranscript({ ...session, sessionId: compactedSessionId });
  }
  const batch = cohort("original");
  promoteAgentRpcYieldReply(batch, input);
  expect(initial.retainReplay(replay)).toBe(true);
  expect(initial.finish(yielded)).toBe(true);
  return { batch, controller, publish, replay };
}

afterEach(() => {
  vi.useRealTimers();
  for (const input of sources.splice(0)) {
    retireSessionControllerInput(input);
  }
});

it("reports a retired preparation failure immediately instead of waiting for the deadline", () => {
  const { batch, publish, replay } = parkOriginal();
  finishUnstartedAgentRpcYieldSuccessor(batch);
  vi.runAllTimers();
  const failure = [
    true,
    {
      runId: "original",
      status: "error",
      summary:
        "The continuation was retired before it could start. Check the child results saved in the session before retrying.",
    },
    undefined,
  ];
  expect(publish).toHaveBeenCalledExactlyOnceWith(failure);
  expect(replay).toHaveBeenCalledExactlyOnceWith(failure);
});

it("follows admitted compaction and returns only the correlated last continuation", () => {
  const compactedSessionId = "compacted-session";
  const { batch, publish, replay } = parkOriginal(compactedSessionId);
  const next = (
    rows: SubagentRunRecord[],
    input = reserve(),
    entry = { ...session, sessionId: compactedSessionId },
  ) =>
    withAgentRpcYieldSuccessor(rows, input, () =>
      observeAgentRpcYieldExecution({ address, entry, input, yieldReply: undefined }),
    );
  expect(next(cohort("original"))).toBeUndefined();
  expect(next(batch, reserve(), { ...session, sessionId: "different-session" })).toBeUndefined();
  expect(
    next(batch, reserve(), {
      ...session,
      sessionId: compactedSessionId,
      lifecycleRevision: "replacement",
    }),
  ).toBeUndefined();
  expect(next(batch, reserve(), session)).toBeUndefined();
  const secondInput = reserve();
  withAgentRpcYieldSuccessor(batch, secondInput, () => {
    expect(
      observeAgentRpcYieldExecution({
        address,
        entry: { ...session, sessionId: compactedSessionId },
        input: reserve(),
        yieldReply: undefined,
      }),
    ).toBeUndefined();
  });
  const second = next(batch, secondInput)!;
  const thirdBatch = cohort("second");
  promoteAgentRpcYieldReply(thirdBatch, secondInput);
  expect(second.finish(yielded)).toBe(false);
  expect(publish).not.toHaveBeenCalled();
  expect(next(thirdBatch)?.finish(final)).toBe(false);
  vi.runAllTimers();
  const originalFinal = [true, { ...final[1], runId: "original" }, undefined];
  expect(publish).toHaveBeenCalledExactlyOnceWith(originalFinal);
  expect(replay).toHaveBeenCalledExactlyOnceWith(originalFinal);
});

it("drops the observer after timeout without preventing the wake", () => {
  const { batch, publish, replay } = parkOriginal();
  vi.advanceTimersByTime(1000);
  const input = reserve();
  withAgentRpcYieldSuccessor(batch, input, () => {
    expect(
      observeAgentRpcYieldExecution({ address, entry: session, input, yieldReply: undefined }),
    ).toBeUndefined();
  });
  const timeout = [
    true,
    { runId: "original", status: "timeout", summary: "aborted", stopReason: "timeout" },
    undefined,
  ];
  expect(publish).toHaveBeenCalledExactlyOnceWith(timeout);
  expect(replay).toHaveBeenCalledExactlyOnceWith(timeout);
});

it("keeps only replay custody after the original transport disconnects", () => {
  const { batch, controller, publish, replay } = parkOriginal();
  controller.abort();
  const input = reserve();
  withAgentRpcYieldSuccessor(batch, input, () => {
    expect(
      observeAgentRpcYieldExecution({
        address,
        entry: session,
        input,
        yieldReply: undefined,
      })?.finish(final),
    ).toBe(false);
  });
  vi.runAllTimers();
  expect(publish).not.toHaveBeenCalled();
  expect(replay).toHaveBeenCalledExactlyOnceWith([
    true,
    { ...final[1], runId: "original" },
    undefined,
  ]);
});
