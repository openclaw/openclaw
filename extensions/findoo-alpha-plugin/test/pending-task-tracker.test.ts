/**
 * L1 — PendingTaskTracker unit tests
 *
 * Tests stream-based tracking: trackStream consumes background SSE stream,
 * fires onCompleted/onFailed callbacks on completion/error/timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { A2AStreamEvent } from "../src/a2a-client.js";
import { extractSummary, PendingTaskTracker } from "../src/pending-task-tracker.js";

/** Helper: create an async generator from an array of events */
async function* mockStream(events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent> {
  for (const e of events) {
    yield e;
  }
}

/** Helper: create a stream that yields events with delays */
async function* delayedStream(
  events: Array<{ event: A2AStreamEvent; delayMs: number }>,
): AsyncGenerator<A2AStreamEvent> {
  for (const { event, delayMs } of events) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield event;
  }
}

function createMockA2A() {
  return {} as unknown as import("../src/a2a-client.js").A2AClient;
}

function makeEvent(
  kind: string,
  state: string,
  final: boolean,
  extra?: Record<string, unknown>,
): A2AStreamEvent {
  return {
    kind: kind as A2AStreamEvent["kind"],
    status: { state },
    final,
    raw: { kind, status: { state }, final, ...extra },
  };
}

describe("PendingTaskTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submit() adds a task to pending list", () => {
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
    });

    const task = tracker.submit("task-1", "分析茅台", {});
    expect(task.taskId).toBe("task-1");
    expect(task.query).toBe("分析茅台");
    expect(task.status).toBe("submitted");
    expect(tracker.getPending()).toHaveLength(1);
  });

  it("trackStream() fires onCompleted when stream has final event", async () => {
    vi.useRealTimers();
    const onCompleted = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: onCompleted,
      onTaskFailed: vi.fn(),
    });

    const stream = mockStream([
      makeEvent("status-update", "working", false),
      makeEvent("status-update", "working", false),
      makeEvent("status-update", "completed", true, { result: "done" }),
    ]);

    tracker.trackStream("task-1", "分析茅台", stream);

    // Wait for stream to be consumed
    await new Promise((r) => setTimeout(r, 50));

    expect(onCompleted).toHaveBeenCalledOnce();
    expect(onCompleted.mock.calls[0][0].taskId).toBe("task-1");
    expect(onCompleted.mock.calls[0][0].status).toBe("completed");
    expect(tracker.getPending()).toHaveLength(0);
  });

  it("trackStream() fires onFailed on error event", async () => {
    vi.useRealTimers();
    const onFailed = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: onFailed,
    });

    const stream = mockStream([
      { kind: "error", final: true, raw: { error: "Agent crashed" } } as A2AStreamEvent,
    ]);

    tracker.trackStream("task-2", "BTC分析", stream);
    await new Promise((r) => setTimeout(r, 50));

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0].status).toBe("failed");
    expect(tracker.getPending()).toHaveLength(0);
  });

  it("trackStream() updates task status to working", async () => {
    vi.useRealTimers();
    const onCompleted = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: onCompleted,
      onTaskFailed: vi.fn(),
    });

    // Use delayed stream so we can check intermediate state
    const stream = delayedStream([
      { event: makeEvent("status-update", "working", false), delayMs: 10 },
      { event: makeEvent("status-update", "completed", true), delayMs: 50 },
    ]);

    tracker.trackStream("task-3", "宏观分析", stream);

    // Check after first event
    await new Promise((r) => setTimeout(r, 30));
    const pending = tracker.getPending();
    if (pending.length > 0) {
      expect(pending[0].status).toBe("working");
    }

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("trackStream() handles stream ending without final flag", async () => {
    vi.useRealTimers();
    const onCompleted = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: onCompleted,
      onTaskFailed: vi.fn(),
    });

    const stream = mockStream([
      makeEvent("status-update", "working", false),
      makeEvent("status-update", "working", false),
    ]);

    tracker.trackStream("task-4", "ETF分析", stream);
    await new Promise((r) => setTimeout(r, 50));

    // Should still complete (stream ended naturally)
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("trackStream() fires onFailed on empty stream", async () => {
    vi.useRealTimers();
    const onFailed = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: onFailed,
    });

    const stream = mockStream([]);
    tracker.trackStream("task-5", "空流", stream);
    await new Promise((r) => setTimeout(r, 50));

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][1]).toContain("Stream ended without events");
  });

  it("trackStream() fires onFailed on stream exception", async () => {
    vi.useRealTimers();
    const onFailed = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: onFailed,
    });

    async function* errorStream(): AsyncGenerator<A2AStreamEvent> {
      yield makeEvent("status-update", "working", false);
      throw new Error("network failure");
    }

    tracker.trackStream("task-6", "网络错误", errorStream());
    await new Promise((r) => setTimeout(r, 50));

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][1]).toContain("network failure");
  });

  it("trackStream() times out long-running streams", async () => {
    vi.useRealTimers();
    const onFailed = vi.fn();
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: onFailed,
      timeoutMs: 100, // very short for testing
    });

    // Stream that takes too long
    async function* slowStream(): AsyncGenerator<A2AStreamEvent> {
      yield makeEvent("status-update", "working", false);
      await new Promise((r) => setTimeout(r, 500));
      yield makeEvent("status-update", "completed", true);
    }

    tracker.trackStream("task-7", "超时测试", slowStream());

    // Wait for timeout to trigger
    await new Promise((r) => setTimeout(r, 200));

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0].status).toBe("timeout");
    expect(onFailed.mock.calls[0][1]).toContain("timed out");
  });

  it("stop() clears all pending tasks", () => {
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
    });

    tracker.submit("task-a", "测试A");
    tracker.submit("task-b", "测试B");
    expect(tracker.getPending()).toHaveLength(2);

    tracker.stop();
    expect(tracker.getPending()).toHaveLength(0);
  });

  it("tracks contextId in tasks", () => {
    const tracker = new PendingTaskTracker({
      a2aClient: createMockA2A(),
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
    });

    const task = tracker.submit("task-ctx", "上下文测试", { contextId: "ctx-123" });
    expect(task.contextId).toBe("ctx-123");
  });
});

describe("extractSummary", () => {
  it("extracts text from artifacts", () => {
    const result = {
      artifacts: [{ parts: [{ kind: "text", text: "茅台分析结果：估值偏高" }] }],
    };
    expect(extractSummary(result)).toBe("茅台分析结果：估值偏高");
  });

  it("extracts text from status.message.parts", () => {
    const result = {
      status: {
        state: "completed",
        message: { parts: [{ kind: "text", text: "BTC 处于牛市周期" }] },
      },
    };
    expect(extractSummary(result)).toBe("BTC 处于牛市周期");
  });

  it("falls back to JSON.stringify", () => {
    const result = { foo: "bar" };
    expect(extractSummary(result)).toBe('{"foo":"bar"}');
  });

  it("truncates long results", () => {
    const longText = "x".repeat(3000);
    const result = { artifacts: [{ parts: [{ kind: "text", text: longText }] }] };
    const summary = extractSummary(result, 100);
    expect(summary.length).toBe(101); // 100 + "…"
    expect(summary.endsWith("…")).toBe(true);
  });
});
