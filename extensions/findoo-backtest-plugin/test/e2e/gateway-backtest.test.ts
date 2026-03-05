/**
 * L3 Gateway E2E — Backtest plugin tools via running Gateway.
 *
 * Requires a running gateway with findoo-backtest-plugin loaded.
 * Skipped unless L3_GATEWAY=1 is set.
 *
 * Usage:
 *   # Start gateway first:
 *   pnpm gateway:dev
 *
 *   # Then run:
 *   L3_GATEWAY=1 pnpm test extensions/findoo-backtest-plugin/test/e2e/gateway-backtest.test.ts
 */

import { describe, expect, it } from "vitest";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:19001";
const AUTH_TOKEN = process.env.GATEWAY_TOKEN ?? "openclaw-local";
const TIMEOUT = 30_000;

async function invokeTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result: Record<string, unknown> }> {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

describe.skipIf(!process.env.L3_GATEWAY)("L3 Gateway — Backtest Plugin Tools", () => {
  // ------------------------------------------------------------------
  // 1. fin_backtest_remote_list — simplest tool, no side effects
  // ------------------------------------------------------------------
  it(
    "fin_backtest_remote_list returns task list",
    async () => {
      const { ok, result } = await invokeTool("fin_backtest_remote_list", { limit: 3 });
      expect(ok).toBe(true);

      const details = result.details as Record<string, unknown>;
      expect(details.success).toBe(true);
      expect(typeof details.total).toBe("number");
      expect(Array.isArray(details.tasks)).toBe(true);
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 2. fin_backtest_remote_status — query a known task
  // ------------------------------------------------------------------
  it(
    "fin_backtest_remote_status returns task structure",
    async () => {
      // First get a task ID from list
      const listResp = await invokeTool("fin_backtest_remote_list", { limit: 1 });
      const listDetails = listResp.result.details as Record<string, unknown>;
      const tasks = listDetails.tasks as Array<{ task_id: string }>;

      if (!tasks || tasks.length === 0) {
        console.warn("No tasks available — skipping status check");
        return;
      }

      const taskId = tasks[0].task_id;
      const { ok, result } = await invokeTool("fin_backtest_remote_status", {
        task_id: taskId,
      });
      expect(ok).toBe(true);

      const details = result.details as Record<string, unknown>;
      expect(details.task_id).toBe(taskId);
      expect(details.status).toBeTruthy();
      expect(details.created_at).toBeTruthy();
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 3. fin_backtest_remote_status with report
  // ------------------------------------------------------------------
  it(
    "fin_backtest_remote_status with include_report returns report data",
    async () => {
      // Find a completed task
      const listResp = await invokeTool("fin_backtest_remote_list", { limit: 20 });
      const listDetails = listResp.result.details as Record<string, unknown>;
      const tasks = listDetails.tasks as Array<{ task_id: string; status: string }>;

      const completedTask = tasks?.find((t) => t.status === "completed");
      if (!completedTask) {
        console.warn("No completed tasks — skipping report check");
        return;
      }

      const { ok, result } = await invokeTool("fin_backtest_remote_status", {
        task_id: completedTask.task_id,
        include_report: true,
      });
      expect(ok).toBe(true);

      const details = result.details as Record<string, unknown>;
      expect(details.task_id).toBe(completedTask.task_id);
      // If report was fetched, report_summary should exist
      if (details.report_summary) {
        const summary = details.report_summary as Record<string, unknown>;
        expect(summary).toHaveProperty("total_return");
        expect(summary).toHaveProperty("sharpe");
      }
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 4. fin_backtest_strategy_check — local validation (error expected)
  // ------------------------------------------------------------------
  it(
    "fin_backtest_strategy_check returns validation errors for nonexistent path",
    async () => {
      const { ok, result } = await invokeTool("fin_backtest_strategy_check", {
        strategy_path: "/tmp/nonexistent-strategy-dir-12345",
      });
      expect(ok).toBe(true);

      const details = result.details as Record<string, unknown>;
      // Should return error or validation failure
      expect(details.valid === false || typeof details.error === "string").toBe(true);
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 5. fin_backtest_remote_cancel — cancel nonexistent (error expected)
  // ------------------------------------------------------------------
  it(
    "fin_backtest_remote_cancel returns error for invalid task ID",
    async () => {
      const { ok, result } = await invokeTool("fin_backtest_remote_cancel", {
        task_id: "bt-nonexistent-12345",
      });
      // Gateway returns ok=true but tool result contains error
      expect(ok).toBe(true);
      const details = result.details as Record<string, unknown>;
      expect(typeof details.error).toBe("string");
    },
    TIMEOUT,
  );
});
