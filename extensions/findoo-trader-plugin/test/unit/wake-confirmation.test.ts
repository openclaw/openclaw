import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentWakeBridge } from "../../src/core/agent-wake-bridge.js";

function createBridge(opts?: { withLog?: boolean }) {
  const tmpDir = mkdtempSync(join(tmpdir(), "wake-confirm-test-"));
  const activityLog = opts?.withLog
    ? new ActivityLogStore(join(tmpDir, "activity.sqlite"))
    : undefined;

  const bridge = new AgentWakeBridge({
    enqueueSystemEvent: vi.fn(),
    sessionKeyResolver: () => "main",
    activityLog,
  });

  return { bridge, activityLog, tmpDir };
}

describe("AgentWakeBridge pending wake tracking (Gap 2)", () => {
  it("records pending wake after fire", () => {
    const { bridge } = createBridge();

    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 25 });

    const pending = bridge.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].contextKey).toContain("health");
    expect(pending[0].contextKey).toContain("drawdown");
  });

  it("reconcilePending removes entries not re-fired this cycle", () => {
    const { bridge, activityLog, tmpDir } = createBridge({ withLog: true });

    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 25 });
    expect(bridge.getPending().length).toBe(1);

    // End cycle 1 (wake was fired this cycle, so it stays)
    bridge.reconcilePending();
    expect(bridge.getPending().length).toBe(1);

    // Cycle 2: no re-fire → reconcile should resolve
    const resolved = bridge.reconcilePending();
    expect(resolved).toBe(1);
    expect(bridge.getPending().length).toBe(0);

    // Activity log should have wake_resolved entry
    const logs = activityLog!.listRecent(10, "wake");
    expect(logs.some((l) => l.action === "wake_resolved")).toBe(true);

    activityLog?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not resolve if contextKey is re-fired", () => {
    const { bridge } = createBridge();

    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 25 });
    // Re-fire same condition in same cycle
    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 30 });

    const resolved = bridge.reconcilePending();
    expect(resolved).toBe(0); // still active, re-fired this cycle
    expect(bridge.getPending().length).toBe(1);
  });

  it("tracks multiple independent wake events", () => {
    const { bridge } = createBridge();

    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 25 });
    bridge.onDailyBriefReady({ totalPnl: 100, strategyCount: 3 });

    expect(bridge.getPending().length).toBe(2);

    // End cycle 1 (both fired this cycle)
    bridge.reconcilePending();
    expect(bridge.getPending().length).toBe(2);

    // Cycle 2: only re-fire health alert, not daily brief
    bridge.onHealthAlert({ accountId: "paper-1", condition: "drawdown", value: 20 });
    const resolved = bridge.reconcilePending();

    expect(resolved).toBe(1); // daily brief resolved
    expect(bridge.getPending().length).toBe(1); // health alert still pending
  });
});
