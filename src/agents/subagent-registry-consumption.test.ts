// Subagent registry consumption tests cover requester-owned orchestration credit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markDescendantCompletionConsumedByRequester } from "./subagent-registry-consumption.js";
import { subagentRuns } from "./subagent-registry-memory.js";

const persistSubagentRunsToDiskMock = vi.hoisted(() => vi.fn());

vi.mock("./subagent-registry-state.js", () => ({
  persistSubagentRunsToDisk: persistSubagentRunsToDiskMock,
}));

describe("markDescendantCompletionConsumedByRequester", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    subagentRuns.clear();
    persistSubagentRunsToDiskMock.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    vi.useRealTimers();
  });

  it("credits requester-consumed descendant completion as delivered", () => {
    const now = Date.now();
    subagentRuns.set("run-consumed-child", {
      runId: "run-consumed-child",
      childSessionKey: "agent:main:subagent:consumed-child",
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      requesterDisplayKey: "cron run",
      task: "child task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 100,
      startedAt: now - 90,
      endedAt: now - 10,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "child result" },
      delivery: { status: "pending", lastError: "announce deferred" },
    });

    const updated = markDescendantCompletionConsumedByRequester({
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      runStartedAt: now - 200,
      runIds: ["run-consumed-child"],
      kind: "cron_descendant_fallback",
      deliveryTextHash: "abc123",
      consumerRunId: "cron-run",
    });

    const run = subagentRuns.get("run-consumed-child");
    expect(updated).toBe(1);
    expect(run?.delivery).toMatchObject({
      status: "delivered",
      requesterConsumedKind: "cron_descendant_fallback",
      requesterConsumedBySessionKey: "agent:main:cron:daily:run:abc",
      requesterConsumedRunStartedAt: now - 200,
      requesterConsumedMetadata: {
        consumerRunId: "cron-run",
        deliveryTextHash: "abc123",
      },
    });
    expect(run?.delivery?.lastError).toBeUndefined();
    expect(persistSubagentRunsToDiskMock).toHaveBeenCalledWith(subagentRuns);
  });

  it("does not credit unrelated requester consumption", () => {
    const now = Date.now();
    subagentRuns.set("run-unrelated-child", {
      runId: "run-unrelated-child",
      childSessionKey: "agent:main:subagent:unrelated-child",
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      requesterDisplayKey: "cron run",
      task: "child task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 100,
      startedAt: now - 90,
      endedAt: now - 10,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "child result" },
      delivery: { status: "pending" },
    });

    const wrongRequester = markDescendantCompletionConsumedByRequester({
      requesterSessionKey: "agent:main:cron:other:run:def",
      runStartedAt: now - 200,
      runIds: ["run-unrelated-child"],
      kind: "cron_descendant_fallback",
    });
    const staleWindow = markDescendantCompletionConsumedByRequester({
      requesterSessionKey: "agent:main:cron:daily:run:abc",
      runStartedAt: now,
      runIds: ["run-unrelated-child"],
      kind: "cron_descendant_fallback",
    });

    const run = subagentRuns.get("run-unrelated-child");
    expect(wrongRequester).toBe(0);
    expect(staleWindow).toBe(0);
    expect(run?.delivery?.status).toBe("pending");
    expect(run?.delivery?.requesterConsumedAt).toBeUndefined();
    expect(persistSubagentRunsToDiskMock).not.toHaveBeenCalled();
  });
});
