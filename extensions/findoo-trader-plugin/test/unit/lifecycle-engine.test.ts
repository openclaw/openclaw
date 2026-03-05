import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { LifecycleEngine } from "../../src/core/lifecycle-engine.js";

// ── Mock helpers ──────────────────────────────────────────────

function createMockRegistry() {
  const strategies = new Map<
    string,
    {
      id: string;
      name: string;
      level: string;
      definition: { symbols: string[]; timeframes: string[]; markets: string[] };
      lastBacktest?: { sharpe: number; maxDrawdown: number; totalTrades: number };
      lastWalkForward?: { passed: boolean; ratio: number; threshold: number };
      updatedAt: number;
      createdAt: number;
    }
  >();

  return {
    list: vi.fn((filter?: { level?: string }) => {
      const all = [...strategies.values()];
      return filter?.level ? all.filter((s) => s.level === filter.level) : all;
    }),
    updateLevel: vi.fn((id: string, level: string) => {
      const s = strategies.get(id);
      if (s) s.level = level;
    }),
    _add(s: { id: string; name: string; level: string }) {
      strategies.set(s.id, {
        ...s,
        definition: { symbols: ["BTC/USDT"], timeframes: ["1h"], markets: ["crypto"] },
        updatedAt: Date.now(),
        createdAt: Date.now(),
      });
    },
  };
}

function createMockFundManager() {
  return {
    buildProfiles: vi.fn((records: unknown[]) =>
      (records as Array<{ id: string; name: string; level: string }>).map((r) => ({
        id: r.id,
        name: r.name,
        level: r.level,
        fitness: 0.5,
      })),
    ),
    checkPromotion: vi.fn((profile: { id: string; level: string }) => ({
      strategyId: profile.id,
      currentLevel: profile.level,
      eligible: false,
      reasons: [],
      blockers: ["not ready"],
    })),
    checkDemotion: vi.fn((profile: { id: string; level: string }) => ({
      strategyId: profile.id,
      currentLevel: profile.level,
      shouldDemote: false,
      reasons: [],
    })),
  };
}

function createMockWakeBridge() {
  return {
    onHealthAlert: vi.fn(),
    onDailyBriefReady: vi.fn(),
    onSeedBacktestComplete: vi.fn(),
    onPromotionReady: vi.fn(),
    onApprovalNeeded: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("LifecycleEngine", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let eventStore: AgentEventSqliteStore;
  let registry: ReturnType<typeof createMockRegistry>;
  let fundManager: ReturnType<typeof createMockFundManager>;
  let wakeBridge: ReturnType<typeof createMockWakeBridge>;
  let engine: LifecycleEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    registry = createMockRegistry();
    fundManager = createMockFundManager();
    wakeBridge = createMockWakeBridge();

    engine = new LifecycleEngine(
      {
        strategyRegistry: registry,
        fundManagerResolver: () => fundManager,
        paperEngine: { listAccounts: () => [], getAccountState: () => null },
        eventStore,
        activityLog,
        wakeBridge: wakeBridge as any,
      },
      60_000, // 1 min for testing
    );
  });

  afterEach(() => {
    engine.stop();
    activityLog.close();
    eventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts and reports stats", () => {
    expect(engine.getStats().running).toBe(false);
    engine.start();
    expect(engine.getStats().running).toBe(true);
    engine.stop();
    expect(engine.getStats().running).toBe(false);
  });

  it("runCycle with no strategies does nothing", async () => {
    const result = await engine.runCycle();
    expect(result).toEqual({ promoted: 0, approvalsSent: 0, demoted: 0, errors: 0 });
    expect(engine.getStats().cycleCount).toBe(1);
  });

  it("auto-promotes L1 to L2 when eligible", async () => {
    registry._add({ id: "s1", name: "Test Strategy", level: "L1_BACKTEST" });

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "s1",
      currentLevel: "L1_BACKTEST",
      eligible: true,
      targetLevel: "L2_PAPER",
      reasons: ["Walk-forward passed", "Sharpe 1.5"],
      blockers: [],
    });

    const result = await engine.runCycle();
    expect(result.promoted).toBe(1);
    expect(registry.updateLevel).toHaveBeenCalledWith("s1", "L2_PAPER");

    // Activity log should have promotion entry
    const logs = activityLog.listRecent(10, "promotion");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].strategyId).toBe("s1");
  });

  it("sends approval for L2→L3 (never auto-promotes)", async () => {
    registry._add({ id: "s2", name: "Mature Strategy", level: "L2_PAPER" });

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "s2",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["30d paper OK", "Sharpe 0.8"],
      blockers: [],
    });

    const result = await engine.runCycle();
    expect(result.approvalsSent).toBe(1);
    expect(result.promoted).toBe(0); // NOT auto-promoted

    // Registry should NOT have been updated to L3
    expect(registry.updateLevel).not.toHaveBeenCalledWith("s2", "L3_LIVE");

    // Event store should have pending approval event
    const events = eventStore.listEvents({ type: "trade_pending" });
    expect(events.length).toBe(1);
    expect(events[0].title).toContain("Mature Strategy");
  });

  it("does not send duplicate approvals", async () => {
    registry._add({ id: "s2", name: "Mature Strategy", level: "L2_PAPER" });

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "s2",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["OK"],
      blockers: [],
    });

    await engine.runCycle();
    const result2 = await engine.runCycle();
    expect(result2.approvalsSent).toBe(0); // already pending
  });

  it("executes demotion when triggered", async () => {
    registry._add({ id: "s3", name: "Failing Strategy", level: "L3_LIVE" });

    fundManager.checkDemotion.mockReturnValue({
      strategyId: "s3",
      currentLevel: "L3_LIVE",
      shouldDemote: true,
      targetLevel: "L2_PAPER",
      reasons: ["7d Sharpe < 0"],
    });

    const result = await engine.runCycle();
    expect(result.demoted).toBe(1);
    expect(registry.updateLevel).toHaveBeenCalledWith("s3", "L2_PAPER");

    const logs = activityLog.listRecent(10, "demotion");
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("handleApproval promotes L2→L3", () => {
    registry._add({ id: "s4", name: "Approved Strategy", level: "L2_PAPER" });

    // First send the approval request
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "s4",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["OK"],
      blockers: [],
    });

    const ok = engine.handleApproval("s4");
    expect(ok).toBe(true);
    expect(registry.updateLevel).toHaveBeenCalledWith("s4", "L3_LIVE");

    const logs = activityLog.listRecent(10, "approval");
    expect(logs.some((l) => l.action === "l3_promotion_approved")).toBe(true);
  });

  it("handleApproval returns false for non-L2 strategy", () => {
    registry._add({ id: "s5", name: "L1 Strategy", level: "L1_BACKTEST" });
    const ok = engine.handleApproval("s5");
    expect(ok).toBe(false);
  });

  it("handleRejection records reason", async () => {
    // Manually add to pending approvals by running a cycle
    registry._add({ id: "s6", name: "Rejected Strategy", level: "L2_PAPER" });

    fundManager.checkPromotion.mockReturnValue({
      strategyId: "s6",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["OK"],
      blockers: [],
    });

    await engine.runCycle(); // creates pending approval

    const ok = engine.handleRejection("s6", "Not ready for live");
    expect(ok).toBe(true);

    const logs = activityLog.listRecent(10, "approval");
    expect(logs.some((l) => l.action === "l3_promotion_rejected")).toBe(true);
  });

  it("handles fundManager unavailable gracefully", async () => {
    const noFundEngine = new LifecycleEngine({
      strategyRegistry: registry,
      fundManagerResolver: () => undefined,
      paperEngine: { listAccounts: () => [], getAccountState: () => null },
      eventStore,
      activityLog,
      wakeBridge: wakeBridge as any,
    });

    const result = await noFundEngine.runCycle();
    expect(result).toEqual({ promoted: 0, approvalsSent: 0, demoted: 0, errors: 0 });
    noFundEngine.stop();
  });
});
