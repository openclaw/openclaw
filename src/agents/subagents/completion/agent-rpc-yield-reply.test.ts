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

function parkOriginal() {
  vi.useFakeTimers();
  const publish = vi.fn();
  const controller = new AbortController();
  const initial = observeAgentRpcYieldExecution({
    ...session,
    runId: "original",
    yieldReply: { signal: controller.signal, deadline: Date.now() + 1000, publish },
  })!;
  const batch = cohort("original");
  promoteAgentRpcYieldReply(batch, "original", 1);
  expect(initial.finish(yielded)).toBe(true);
  return { batch, controller, publish };
}

afterEach(() => vi.useRealTimers());

it("reports a retired preparation failure immediately instead of waiting for the deadline", () => {
  const { batch, publish } = parkOriginal();
  finishUnstartedAgentRpcYieldSuccessor(batch);
  vi.runAllTimers();
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    [true, { status: "error", summary: "failed" }, undefined],
    "original",
  );
});

it("returns only the correlated last continuation, including a second yield", () => {
  const { batch, publish } = parkOriginal();
  const next = (rows: SubagentRunRecord[], runId: string, sessionId = session.sessionId) =>
    withAgentRpcYieldSuccessor(rows, runId, () =>
      observeAgentRpcYieldExecution({ ...session, sessionId, runId, yieldReply: undefined }),
    );
  expect(next(cohort("original"), "unrelated")).toBeUndefined();
  expect(next(batch, "replacement", "different-session")).toBeUndefined();
  const second = next(batch, "second")!;
  const thirdBatch = cohort("second");
  promoteAgentRpcYieldReply(thirdBatch, "second", 1);
  expect(second.finish(yielded)).toBe(false);
  expect(publish).not.toHaveBeenCalled();
  expect(next(thirdBatch, "third")?.finish(final)).toBe(false);
  vi.runAllTimers();
  expect(publish).toHaveBeenCalledExactlyOnceWith(final, "original");
});

it.each(["timeout", "disconnect"] as const)(
  "drops the observer after %s without preventing the wake",
  (end) => {
    const { batch, controller, publish } = parkOriginal();
    if (end === "disconnect") {
      controller.abort();
    }
    vi.advanceTimersByTime(1000);
    withAgentRpcYieldSuccessor(batch, "next", () => {
      expect(
        observeAgentRpcYieldExecution({ ...session, runId: "next", yieldReply: undefined }),
      ).toBeUndefined();
    });
    if (end === "timeout") {
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        [true, expect.objectContaining({ status: "timeout" }), undefined],
        "original",
      );
    } else {
      expect(publish).not.toHaveBeenCalled();
    }
  },
);
