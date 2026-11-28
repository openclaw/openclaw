import { afterEach, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  finishUnstartedAgentRpcYieldSuccessor,
  observeAgentRpcYieldExecution,
  promoteAgentRpcYieldReply,
  withAgentRpcYieldSuccessor,
} from "./agent-rpc-yield-reply.js";

const session = { sessionId: "requester-session", sessionKey: "agent:main:requester" };
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
      requesterSessionKey: session.sessionKey,
      requesterDisplayKey: session.sessionKey,
      task: "child task",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterRunId: runId,
        rearmGeneration: 1,
      },
    },
  ];
}

function parkOriginal(compactedSessionId?: string) {
  vi.useFakeTimers();
  const publish = vi.fn();
  const replay = vi.fn();
  const controller = new AbortController();
  const initial = observeAgentRpcYieldExecution({
    ...session,
    runId: "original",
    yieldReply: { signal: controller.signal, deadline: Date.now() + 1000, publish },
  })!;
  if (compactedSessionId) {
    initial.updateSessionId(compactedSessionId);
  }
  const batch = cohort("original");
  promoteAgentRpcYieldReply(batch, "original", 1);
  expect(initial.retainReplay(replay)).toBe(true);
  expect(initial.finish(yielded)).toBe(true);
  return { batch, controller, publish, replay };
}

afterEach(() => vi.useRealTimers());

it("reports a retired preparation failure immediately instead of waiting for the deadline", () => {
  const { batch, publish } = parkOriginal();
  finishUnstartedAgentRpcYieldSuccessor(batch);
  vi.runAllTimers();
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    [true, { runId: "original", status: "error", summary: "failed" }, undefined],
    "original",
  );
});

it("follows admitted compaction and returns only the correlated last continuation", () => {
  const compactedSessionId = "compacted-session";
  const { batch, publish, replay } = parkOriginal(compactedSessionId);
  const next = (rows: SubagentRunRecord[], runId: string, sessionId = compactedSessionId) =>
    withAgentRpcYieldSuccessor(rows, runId, () =>
      observeAgentRpcYieldExecution({ ...session, sessionId, runId, yieldReply: undefined }),
    );
  expect(next(cohort("original"), "unrelated")).toBeUndefined();
  expect(next(batch, "replacement", "different-session")).toBeUndefined();
  expect(next(batch, "pre-compaction", session.sessionId)).toBeUndefined();
  const second = next(batch, "second")!;
  const thirdBatch = cohort("second");
  promoteAgentRpcYieldReply(thirdBatch, "second", 1);
  expect(second.finish(yielded)).toBe(false);
  expect(publish).not.toHaveBeenCalled();
  expect(next(thirdBatch, "third")?.finish(final)).toBe(false);
  vi.runAllTimers();
  const originalFinal = [true, { ...final[1], runId: "original" }, undefined];
  expect(publish).toHaveBeenCalledExactlyOnceWith(originalFinal, "original");
  expect(replay).toHaveBeenCalledExactlyOnceWith(originalFinal);
});

it("drops the observer after timeout without preventing the wake", () => {
  const { batch, publish, replay } = parkOriginal();
  vi.advanceTimersByTime(1000);
  withAgentRpcYieldSuccessor(batch, "next", () => {
    expect(
      observeAgentRpcYieldExecution({ ...session, runId: "next", yieldReply: undefined }),
    ).toBeUndefined();
  });
  const timeout = [
    true,
    { runId: "original", status: "timeout", summary: "aborted", stopReason: "timeout" },
    undefined,
  ];
  expect(publish).toHaveBeenCalledExactlyOnceWith(timeout, "original");
  expect(replay).toHaveBeenCalledExactlyOnceWith(timeout);
});

it("keeps only replay custody after the original transport disconnects", () => {
  const { batch, controller, publish, replay } = parkOriginal();
  controller.abort();
  withAgentRpcYieldSuccessor(batch, "next", () => {
    expect(
      observeAgentRpcYieldExecution({ ...session, runId: "next", yieldReply: undefined })?.finish(
        final,
      ),
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
