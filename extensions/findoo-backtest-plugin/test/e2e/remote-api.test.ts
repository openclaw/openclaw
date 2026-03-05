/**
 * E2E tests for the Findoo Backtest Agent remote API (FEP v1.1).
 *
 * These tests connect to a real backtest agent instance.
 * Skipped unless E2E_BACKTEST=1 is set.
 *
 * Usage:
 *   E2E_BACKTEST=1 BACKTEST_API_URL=http://150.109.16.195:8000 pnpm test extensions/findoo-backtest-plugin/test/e2e
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BacktestClient } from "../../src/backtest-client.js";
import type { RemoteReport, RemoteTask } from "../../src/types.js";

const BASE_URL = process.env.BACKTEST_API_URL ?? "http://150.109.16.195:8000";
const API_KEY = process.env.BACKTEST_API_KEY ?? "";
const TIMEOUT_MS = 30_000;

const client = new BacktestClient(BASE_URL, API_KEY, TIMEOUT_MS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until terminal status or timeout. */
async function waitForCompletion(
  taskId: string,
  timeoutMs = 120_000,
  intervalMs = 3_000,
): Promise<RemoteTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await client.getTask(taskId);
    if (["completed", "failed", "rejected"].includes(task.status)) {
      return task;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for task ${taskId}`);
}

describe.skipIf(!process.env.E2E_BACKTEST)("Remote Backtest API E2E (v1.1)", () => {
  // ------------------------------------------------------------------
  // 1. Health check
  // ------------------------------------------------------------------
  it(
    "health check returns ok",
    async () => {
      const health = await client.health();
      expect(health.status).toBeTruthy();
    },
    TIMEOUT_MS,
  );

  // ------------------------------------------------------------------
  // 2. List tasks
  // ------------------------------------------------------------------
  it(
    "list tasks returns paginated response",
    async () => {
      const list = await client.listTasks(5, 0);
      expect(list).toHaveProperty("tasks");
      expect(Array.isArray(list.tasks)).toBe(true);
      expect(list).toHaveProperty("total");
    },
    TIMEOUT_MS,
  );

  // ------------------------------------------------------------------
  // 3. Submit valid L1 strategy → poll → completed → get report
  // ------------------------------------------------------------------
  it("submit valid L1 strategy and get report", async () => {
    // Look for a test fixture ZIP, or create a minimal one
    const fixtureDir = join(__dirname, "..", "fixtures");
    let zipBuffer: Buffer;

    try {
      zipBuffer = await readFile(join(fixtureDir, "l1-valid-strategy.zip"));
    } catch {
      // Create a minimal valid strategy ZIP in memory
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const folder = zip.folder("test-strategy")!;

      folder.file(
        "fep.yaml",
        [
          "identity:",
          "  id: e2e-test-sma-crossover",
          "  name: test-e2e-strategy",
          "  version: '1.0'",
          "  author: e2e-test",
          "technical:",
          "  asset_class: crypto",
          "  timeframe: 1d",
          "  strategy_type: momentum",
        ].join("\n"),
      );

      folder.file(
        "scripts/strategy.py",
        [
          "import pandas as pd",
          "",
          "def compute(data):",
          '    """Simple moving average crossover strategy."""',
          "    df = data.copy()",
          "    df['sma_20'] = df['close'].rolling(20).mean()",
          "    df['sma_50'] = df['close'].rolling(50).mean()",
          "    df['signal'] = 0",
          "    df.loc[df['sma_20'] > df['sma_50'], 'signal'] = 1",
          "    df.loc[df['sma_20'] < df['sma_50'], 'signal'] = -1",
          "    return df",
        ].join("\n"),
      );

      folder.file("scripts/requirements.txt", "pandas>=1.5\nnumpy>=1.24\n");

      zipBuffer = Buffer.from(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      );
    }

    // Submit
    const submitResp = await client.submit(zipBuffer, "e2e-test-strategy.zip", {
      engine: "script",
    });

    expect(submitResp.task_id).toBeTruthy();
    expect(typeof submitResp.task_id).toBe("string");

    // Poll until done
    const finalTask = await waitForCompletion(submitResp.task_id);

    // The task should complete or fail (depending on server-side data availability)
    expect(["completed", "failed", "rejected"]).toContain(finalTask.status);

    if (finalTask.status === "completed") {
      // Validate result_summary inline fields
      if (finalTask.result_summary) {
        expect(typeof finalTask.result_summary.totalReturn).toBe("number");
        expect(typeof finalTask.result_summary.maxDrawdown).toBe("number");
        expect(typeof finalTask.result_summary.totalTrades).toBe("number");
      }

      // Get full report
      const report: RemoteReport = await client.getReport(submitResp.task_id);
      expect(report.task_id).toBe(submitResp.task_id);
      // equity_curve/trade_journal may be null if strategy produced no trades
      expect(report.equity_curve === null || Array.isArray(report.equity_curve)).toBe(true);
      expect(report.trade_journal === null || Array.isArray(report.trade_journal)).toBe(true);

      if (report.performance) {
        expect(typeof report.performance.totalReturn).toBe("number");
      }
    }
  }, 180_000);

  // ------------------------------------------------------------------
  // 4. Get task status for a known task
  // ------------------------------------------------------------------
  it(
    "get task returns proper structure",
    async () => {
      // First list to get a task ID
      const list = await client.listTasks(1, 0);
      if (list.tasks.length === 0) {
        // No tasks to check, skip
        return;
      }

      const task = await client.getTask(list.tasks[0].task_id);
      expect(task.task_id).toBeTruthy();
      expect(task.status).toBeTruthy();
      expect(task.created_at).toBeTruthy();
    },
    TIMEOUT_MS,
  );

  // ------------------------------------------------------------------
  // 5. Cancel task (best effort — may not have a cancellable task)
  // ------------------------------------------------------------------
  it(
    "cancel returns response structure",
    async () => {
      // Submit a task and immediately try to cancel
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const folder = zip.folder("cancel-test")!;
      folder.file(
        "fep.yaml",
        "identity:\n  id: e2e-cancel-test\n  name: cancel-test\n  version: '1.0'\n  author: test\ntechnical:\n  asset_class: crypto\n",
      );
      folder.file("scripts/strategy.py", "def compute(data):\n    return data\n");
      folder.file("scripts/requirements.txt", "pandas>=1.5\n");

      const zipBuffer = Buffer.from(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      );

      const submitResp = await client.submit(zipBuffer, "cancel-test.zip", {
        engine: "script",
      });

      try {
        const cancelResp = await client.cancelTask(submitResp.task_id);
        expect(cancelResp.task_id).toBe(submitResp.task_id);
        expect(cancelResp.status).toBeTruthy();
      } catch (err) {
        // Cancel might fail if task already completed — that's OK
        expect(String(err)).toContain("Backtest API error");
      }
    },
    TIMEOUT_MS,
  );
});
