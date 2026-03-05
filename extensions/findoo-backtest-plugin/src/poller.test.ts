import { describe, expect, it, vi } from "vitest";
import { isTerminal, pollUntilDone } from "./poller.js";
import type { RemoteReport, RemoteTask } from "./types.js";

function makeTask(status: string, message?: string): RemoteTask {
  return {
    task_id: "t1",
    status: status as RemoteTask["status"],
    created_at: "2024-01-01T00:00:00Z",
    message,
  };
}

const MOCK_REPORT: RemoteReport = {
  task_id: "t1",
  performance: {
    totalReturn: 15.0,
    sharpe: 1.2,
    maxDrawdown: 8.0,
    totalTrades: 42,
  },
  alpha: null,
  equity_curve: null,
  trade_journal: null,
};

function mockClient(taskSequence: RemoteTask[], report = MOCK_REPORT) {
  let callIndex = 0;
  return {
    getTask: vi.fn(async () => taskSequence[Math.min(callIndex++, taskSequence.length - 1)]),
    getReport: vi.fn(async () => report),
    submit: vi.fn(),
    listTasks: vi.fn(),
    cancelTask: vi.fn(),
    health: vi.fn(),
  };
}

describe("isTerminal", () => {
  it("returns true for completed/failed/rejected", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
  });

  it("returns false for non-terminal statuses", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("submitted")).toBe(false);
    expect(isTerminal("processing")).toBe(false);
  });
});

describe("pollUntilDone", () => {
  it("returns immediately if task already completed", async () => {
    const client = mockClient([makeTask("completed")]);

    const result = await pollUntilDone(client as never, "t1", {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(result.task.status).toBe("completed");
    expect(result.report).toBeDefined();
    expect(client.getTask).toHaveBeenCalledTimes(1);
    expect(client.getReport).toHaveBeenCalledTimes(1);
  });

  it("polls until completed", async () => {
    const client = mockClient([makeTask("queued"), makeTask("processing"), makeTask("completed")]);

    const result = await pollUntilDone(client as never, "t1", {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(result.task.status).toBe("completed");
    expect(client.getTask).toHaveBeenCalledTimes(3);
  });

  it("throws on failed task", async () => {
    const client = mockClient([makeTask("failed", "Strategy crash")]);

    await expect(
      pollUntilDone(client as never, "t1", { intervalMs: 10, timeoutMs: 5000 }),
    ).rejects.toThrow("Backtest failed: Strategy crash");
  });

  it("throws on rejected task", async () => {
    const rejectedTask = makeTask("rejected");
    rejectedTask.reject_reason = "Strategy contains unsafe imports";
    const client = mockClient([rejectedTask]);

    await expect(
      pollUntilDone(client as never, "t1", { intervalMs: 10, timeoutMs: 5000 }),
    ).rejects.toThrow("Backtest rejected: Strategy contains unsafe imports");
    expect(client.getReport).not.toHaveBeenCalled();
  });

  it("throws on rejected task with fallback message field", async () => {
    const rejectedTask = makeTask("rejected", "Policy violation");
    const client = mockClient([rejectedTask]);

    await expect(
      pollUntilDone(client as never, "t1", { intervalMs: 10, timeoutMs: 5000 }),
    ).rejects.toThrow("Backtest rejected: Policy violation");
  });

  it("transitions through multiple non-terminal statuses", async () => {
    const client = mockClient([
      makeTask("submitted"),
      makeTask("queued"),
      makeTask("processing"),
      makeTask("completed"),
    ]);

    const result = await pollUntilDone(client as never, "t1", {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(result.task.status).toBe("completed");
    expect(client.getTask).toHaveBeenCalledTimes(4);
    expect(client.getReport).toHaveBeenCalledTimes(1);
  });

  it("throws on timeout", async () => {
    const client = mockClient([makeTask("processing")]);

    await expect(
      pollUntilDone(client as never, "t1", { intervalMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow("poll timeout");
  });
});
