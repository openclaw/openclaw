import { describe, expect, it, vi } from "vitest";
import { isTerminal, pollUntilDone } from "./poller.js";
import type { RemoteReport, RemoteTask } from "./types.js";

function makeTask(status: string, error?: string): RemoteTask {
  return {
    task_id: "t1",
    status: status as RemoteTask["status"],
    engine: "script",
    strategy_dir: "strats/test",
    symbol: "BTC-USD",
    initial_capital: 100000,
    start_date: "2024-01-01",
    end_date: "2024-12-31",
    created_at: "2024-01-01T00:00:00Z",
    error,
  };
}

const MOCK_REPORT: RemoteReport = {
  task_id: "t1",
  result_summary: {
    total_return: 0.15,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.5,
    max_drawdown: -0.08,
    calmar_ratio: 1.88,
    win_rate: 0.55,
    profit_factor: 1.8,
    total_trades: 42,
    final_equity: 115000,
  },
  trades: [],
  equity_curve: [],
};

function mockClient(taskSequence: RemoteTask[], report = MOCK_REPORT) {
  let callIndex = 0;
  return {
    getTask: vi.fn(async () => taskSequence[Math.min(callIndex++, taskSequence.length - 1)]),
    getReport: vi.fn(async () => report),
    // Unused but required for type
    submit: vi.fn(),
    listTasks: vi.fn(),
    cancelTask: vi.fn(),
    health: vi.fn(),
  };
}

describe("isTerminal", () => {
  it("returns true for completed/failed/cancelled", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("returns false for queued/running", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
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
    const client = mockClient([makeTask("queued"), makeTask("running"), makeTask("completed")]);

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

  it("returns cancelled task without report", async () => {
    const client = mockClient([makeTask("cancelled")]);

    const result = await pollUntilDone(client as never, "t1", {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(result.task.status).toBe("cancelled");
    expect(result.report).toBeUndefined();
    expect(client.getReport).not.toHaveBeenCalled();
  });

  it("throws on timeout", async () => {
    // Always returns running — should timeout
    const client = mockClient([makeTask("running")]);

    await expect(
      pollUntilDone(client as never, "t1", { intervalMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow("poll timeout");
  });
});
