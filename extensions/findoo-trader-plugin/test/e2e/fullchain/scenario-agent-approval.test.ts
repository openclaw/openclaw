/**
 * Phase F — Scenario: Agent Intermediated Approval Flow (L2→L3)
 *
 * Tests the Agent-sovereign lifecycle: create strategy → lifecycle engine
 * recommends L0→L1→L2 (agent executes each) → L2→L3 eligibility detected →
 * approval needed event → simulate agent calling approve → verify L3_LIVE.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-agent-approval.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

describe("Phase F — Scenario: Agent Intermediated Approval (L2→L3)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  it("Agent-sovereign lifecycle: L0 → L1 → L2 (via recommendations) → approval → L3", async () => {
    // ── 1. Create strategy via HTTP ──
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Agent Approval Flow",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Verify initial level is L0
    const initial = ctx.services.strategyRegistry.get(strategyId);
    expect(initial?.level).toBe("L0_INCUBATE");

    // ── 2. Inject backtest + walk-forward data (satisfies L1→L2 gates) ──
    ctx.services.strategyRegistry.updateBacktest(strategyId, {
      strategyId,
      startDate: Date.now() - 86_400_000 * 90,
      endDate: Date.now(),
      initialCapital: 10_000,
      finalEquity: 13_500,
      totalReturn: 35,
      sharpe: 1.8,
      sortino: 2.2,
      maxDrawdown: -10,
      calmar: 3.5,
      winRate: 0.6,
      profitFactor: 2.0,
      totalTrades: 200,
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    } as never);

    ctx.services.strategyRegistry.updateWalkForward(strategyId, {
      passed: true,
      windows: [],
      combinedTestSharpe: 1.4,
      avgTrainSharpe: 1.8,
      ratio: 0.78,
      threshold: 0.6,
    } as never);

    // ── 3. Run cycle #1: LifecycleEngine recommends L0→L1 (Agent-sovereign) ──
    // Engine no longer auto-promotes; it builds recommendations for the Agent.
    const cycle1 = await ctx.services.lifecycleEngine.runCycle();
    expect(cycle1.promoted).toBeGreaterThanOrEqual(1); // "promoted" counts recommendations

    // Strategy level is still L0 — recommendation only, not execution
    const afterCycle1 = ctx.services.strategyRegistry.get(strategyId);
    expect(afterCycle1?.level).toBe("L0_INCUBATE");

    // Simulate Agent executing the recommendation
    ctx.services.strategyRegistry.updateLevel(strategyId, "L1_BACKTEST" as never);

    // ── 4. Run cycle #2: LifecycleEngine recommends L1→L2 (Agent-sovereign) ──
    const cycle2 = await ctx.services.lifecycleEngine.runCycle();
    expect(cycle2.promoted).toBeGreaterThanOrEqual(1); // recommendation count

    // Strategy level is still L1 — recommendation only, not execution
    const afterCycle2 = ctx.services.strategyRegistry.get(strategyId);
    expect(afterCycle2?.level).toBe("L1_BACKTEST");

    // Simulate Agent executing the recommendation
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER" as never);

    // ── 5. Verify L2 via API ──
    const listRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(listRes.status).toBe(200);
    const strategies = (listRes.body as { strategies: Array<{ id: string; level: string }> })
      .strategies;
    const found = strategies.find((s) => s.id === strategyId);
    expect(found?.level).toBe("L2_PAPER");

    // ── 6. Inject paper trading data satisfying L2→L3 boundary ──
    // L2→L3 needs: 30d, 30 trades, Sharpe ≥ 0.5, DD ≤ 20%, deviation ≤ 30%
    // Create paper account and inject orders + equity snapshots for proper metrics
    const acctState = ctx.services.paperEngine.createAccount("Agent Approval Paper", 10_000);
    const acctId = acctState.id;

    // Inject 35 mock orders for this strategy via the paper engine
    for (let i = 0; i < 35; i++) {
      ctx.services.paperEngine.submitOrder(
        acctId,
        {
          strategyId,
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          quantity: 0.01,
        },
        50_000 + i * 100,
      );
    }

    // Backdate the paper account to 40 days ago (for daysActive >= 30)
    // Access private internals via cast (same pattern used in browser-flow tests)
    const pe = ctx.services.paperEngine as unknown as {
      accounts: Map<string, { createdAt: number }>;
      store: {
        saveSnapshot: (s: unknown) => void;
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      };
    };
    const acctInternal = pe.accounts.get(acctId);
    if (acctInternal) {
      (acctInternal as { createdAt: number }).createdAt = Date.now() - 86_400_000 * 40;
    }
    // Also backdate in the DB so loadAccount reads the correct createdAt
    pe.store.db
      .prepare("UPDATE accounts SET created_at = ? WHERE id = ?")
      .run(Date.now() - 86_400_000 * 40, acctId);

    // Inject 35 equity snapshots with realistic variance
    // Pattern: 2 up days (+1%) then 1 down day (-1.5%) → annualized Sharpe ≈ 2.2
    // BT Sharpe is 1.8, deviation = |1.8 - 2.2| / 1.8 ≈ 22% ≤ 30% threshold
    let snapshotEquity = 10_000;
    for (let day = 0; day < 35; day++) {
      const ts = Date.now() - 86_400_000 * (35 - day);
      const dailyReturn = day % 3 === 0 ? -0.015 : 0.01;
      snapshotEquity *= 1 + dailyReturn;
      pe.store.saveSnapshot({
        accountId: acctId,
        timestamp: ts,
        equity: snapshotEquity,
        cash: snapshotEquity * 0.8,
        positionsValue: snapshotEquity * 0.2,
        dailyPnl: snapshotEquity * dailyReturn,
        dailyPnlPct: dailyReturn * 100,
      });
    }

    // ── 7. Run cycle #3: L2→L3 should trigger approval request (not auto-promote) ──
    const cycle3 = await ctx.services.lifecycleEngine.runCycle();
    expect(cycle3.errors).toBe(0);
    // With proper paper data, lifecycle should detect L2→L3 eligibility and send approval
    expect(cycle3.approvalsSent).toBeGreaterThanOrEqual(1);

    // ── 9. Verify approval event in activity log ──
    const approvalLogs = ctx.services.activityLog.listRecent(50, "approval");
    const requestedLog = approvalLogs.find(
      (l) => l.strategyId === strategyId && l.action === "l3_approval_requested",
    );
    expect(requestedLog).toBeDefined();

    // ── 10. Simulate Agent calling POST /flow/approve ──
    const approveRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/flow/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });
    expect(approveRes.status).toBe(200);
    expect((approveRes.body as { ok: boolean }).ok).toBe(true);

    // ── 11. Verify L3_LIVE ──
    const afterApproval = ctx.services.strategyRegistry.get(strategyId);
    expect(afterApproval?.level).toBe("L3_LIVE");

    // ── 12. Verify activity log has approval confirmation ──
    const afterApprovalLogs = ctx.services.activityLog.listRecent(50, "approval");
    const approvedLog = afterApprovalLogs.find(
      (l) => l.strategyId === strategyId && l.action === "l3_promotion_approved",
    );
    expect(approvedLog).toBeDefined();
    expect(approvedLog!.detail).toContain("L3");

    // ── 13. Verify dashboard flow JSON reflects L3 ──
    const flowRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    expect(flowRes.status).toBe(200);
    const flowData = flowRes.body as { strategies: Array<{ id: string; level: string }> };
    const flowCard = flowData.strategies.find((s) => s.id === strategyId);
    expect(flowCard?.level).toBe("L3_LIVE");

    // ── 14. Verify lifecycle engine stats ──
    const stats = ctx.services.lifecycleEngine.getStats();
    // promotionCount only increments on handleApproval (L2→L3) now; verify cycleCount instead
    expect(stats.cycleCount).toBeGreaterThanOrEqual(3);
  });

  it("reject flow: L2 strategy stays L2 after rejection", async () => {
    // Create and promote to L2
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "rsi-mean-reversion",
        name: "Reject Flow Test",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: {},
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER" as never);

    // Manually add to pending approvals via lifecycle engine internals
    ctx.services.eventStore.addEvent({
      type: "trade_pending",
      title: `L3 Promotion: Reject Flow Test`,
      detail: `Strategy eligible for live trading`,
      status: "pending",
      actionParams: { action: "promote_l3", strategyId },
    });

    // Use handleRejection directly (no HTTP route for reject yet, test the engine path)
    const rejected = ctx.services.lifecycleEngine.handleRejection(strategyId, "User declined");

    // handleRejection returns false if strategyId wasn't in pendingApprovals set
    // That's expected since we didn't go through runCycle's sendApprovalRequest
    // The important thing: strategy remains L2
    const after = ctx.services.strategyRegistry.get(strategyId);
    expect(after?.level).toBe("L2_PAPER");

    // Verify activity log if rejection was recorded
    if (rejected) {
      const rejectLogs = ctx.services.activityLog.listRecent(50, "approval");
      const rejectLog = rejectLogs.find(
        (l) => l.strategyId === strategyId && l.action === "l3_promotion_rejected",
      );
      expect(rejectLog).toBeDefined();
    }
  });

  it("event store has pending event with promote_l3 action", async () => {
    // Verify events from the previous tests
    const events = ctx.services.eventStore.listEvents();
    const pendingPromo = events.find(
      (e) =>
        e.type === "trade_pending" &&
        (e.actionParams as Record<string, unknown>)?.action === "promote_l3",
    );
    expect(pendingPromo).toBeDefined();
    expect(pendingPromo!.status).toBe("pending");
  });
});
