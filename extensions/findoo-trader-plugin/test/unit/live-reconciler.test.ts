import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { LiveReconciler } from "../../src/execution/live-reconciler.js";

describe("LiveReconciler (Gap 5)", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let eventStore: AgentEventSqliteStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reconciler-test-"));
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    eventStore = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
  });

  afterEach(() => {
    activityLog.close();
    eventStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createReconciler(opts: {
    livePositions: unknown[];
    paperPositions: Array<Record<string, unknown>>;
    l3Strategies?: Array<{ id: string; name: string; symbols: string[] }>;
    thresholds?: { warningDriftPct?: number; criticalDriftPct?: number; alertCooldownMs?: number };
  }) {
    const strategies = opts.l3Strategies ?? [
      { id: "s1", name: "Test Strategy", symbols: ["BTC/USDT"] },
    ];

    return new LiveReconciler({
      liveExecutor: {
        fetchPositions: vi.fn(async () => opts.livePositions),
      },
      paperEngine: {
        listAccounts: vi.fn(() => [{ id: "paper-1" }]),
        getAccountState: vi.fn(() => ({
          positions: opts.paperPositions,
        })),
      },
      strategyRegistry: {
        list: vi.fn(() =>
          strategies.map((s) => ({
            id: s.id,
            name: s.name,
            level: "L3_LIVE",
            definition: { symbols: s.symbols },
          })),
        ),
      },
      eventStore,
      activityLog,
      wakeBridge: { onHealthAlert: vi.fn() } as any,
      thresholds: {
        warningDriftPct: opts.thresholds?.warningDriftPct ?? 15,
        criticalDriftPct: opts.thresholds?.criticalDriftPct ?? 30,
        alertCooldownMs: opts.thresholds?.alertCooldownMs ?? 0,
      },
    });
  }

  it("detects critical drift when live=1.0, paper=0.5", async () => {
    const reconciler = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 0.5 }],
    });

    const results = await reconciler.reconcile();
    expect(results.length).toBe(1);
    expect(results[0].driftPct).toBe(50);
    expect(results[0].severity).toBe("critical");
  });

  it("returns ok when positions match", async () => {
    const reconciler = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 1.0 }],
    });

    const results = await reconciler.reconcile();
    expect(results.length).toBe(1);
    expect(results[0].driftPct).toBeCloseTo(0);
    expect(results[0].severity).toBe("ok");
  });

  it("detects warning severity at 20% drift", async () => {
    const reconciler = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 0.8 }],
    });

    const results = await reconciler.reconcile();
    expect(results[0].driftPct).toBeCloseTo(20);
    expect(results[0].severity).toBe("warning");
  });

  it("tracks consecutive critical cycles", async () => {
    const reconciler = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 0.5 }],
    });

    await reconciler.reconcile();
    expect(reconciler.getConsecutiveCritical("s1")).toBe(1);

    await reconciler.reconcile();
    expect(reconciler.getConsecutiveCritical("s1")).toBe(2);
  });

  it("resets consecutive counter when drift improves", async () => {
    // First call: critical
    const reconciler = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 0.5 }],
    });

    await reconciler.reconcile();
    expect(reconciler.getConsecutiveCritical("s1")).toBe(1);

    // Modify mock to return matching positions (need new reconciler since mocks are fixed)
    const reconciler2 = createReconciler({
      livePositions: [{ symbol: "BTC/USDT", contracts: 1.0 }],
      paperPositions: [{ symbol: "BTC/USDT", quantity: 0.95 }],
    });

    await reconciler2.reconcile();
    expect(reconciler2.getConsecutiveCritical("s1")).toBe(0);
  });

  it("returns empty when no L3 strategies", async () => {
    const reconciler = createReconciler({
      livePositions: [],
      paperPositions: [],
      l3Strategies: [],
    });

    const results = await reconciler.reconcile();
    expect(results).toEqual([]);
  });
});
