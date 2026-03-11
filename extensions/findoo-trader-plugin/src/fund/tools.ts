import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { OHLCV, StrategyContext, StrategyDefinition, Signal } from "../shared/types.js";
import { buildIndicatorLib } from "../strategy/indicator-lib.js";
import type { CapitalFlowStore } from "./capital-flow-store.js";
import type { FundManager } from "./fund-manager.js";
import type {
  PerformanceSnapshotStore,
  PerformanceSnapshot,
} from "./performance-snapshot-store.js";
import type { FundConfig, PromotionCheck } from "./types.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

type RegistryLike = {
  list: (filter?: { level?: string }) => Array<{
    id: string;
    name: string;
    version: string;
    level: string;
    definition: StrategyDefinition;
    createdAt: number;
    updatedAt: number;
    lastBacktest?: unknown;
    lastWalkForward?: unknown;
  }>;
  get: (id: string) => unknown;
  updateLevel: (id: string, level: string) => void;
};

type PaperLike = {
  listAccounts: () => Array<{ id: string; name: string; equity: number }>;
  getAccountState: (id: string) => {
    id: string;
    initialCapital: number;
    equity: number;
    cash?: number;
    positions: Array<Record<string, unknown>>;
    orders: Array<{ strategyId?: string }>;
    createdAt: number;
  } | null;
  getMetrics: (id: string) => unknown;
  submitOrder: (
    accountId: string,
    order: Record<string, unknown>,
    currentPrice: number,
  ) => Record<string, unknown>;
  recordSnapshot: (accountId: string) => void;
};

type DataProviderLike = {
  getOHLCV: (params: {
    symbol: string;
    market: string;
    timeframe: string;
    limit?: number;
  }) => Promise<OHLCV[]>;
  getTicker?: (symbol: string, market: string) => Promise<{ close?: number } | null>;
};

type LiveExecutorLike = {
  placeOrder: (params: {
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit";
    amount: number;
    price?: number;
    exchangeId?: string;
  }) => Promise<{ orderId: string; status: string; filled?: number }>;
};

type RegimeDetectorLike = {
  detect: (ohlcv: OHLCV[]) => string;
};

export type FundToolDeps = {
  manager: FundManager;
  config: FundConfig;
  flowStore: CapitalFlowStore;
  perfStore: PerformanceSnapshotStore;
  getRegistry: () => RegistryLike | undefined;
  getPaper: () => PaperLike | undefined;
  getDataProvider?: () => DataProviderLike | undefined;
  getLiveExecutor?: () => LiveExecutorLike | undefined;
  getRegimeDetector?: () => RegimeDetectorLike | undefined;
};

export function registerFundTools(api: OpenClawPluginApi, deps: FundToolDeps): void {
  const { manager, config, flowStore, perfStore, getRegistry, getPaper } = deps;

  // Track the previous equity to compute PnL across rebalances
  let lastRecordedEquity: number | null = null;

  /** Record a daily performance snapshot after rebalance. */
  function recordDailySnapshot(): void {
    const paper = getPaper();
    let currentEquity = config.totalCapital ?? manager.getState().totalCapital;
    if (paper) {
      const accounts = paper.listAccounts();
      if (accounts.length > 0) {
        currentEquity = accounts.reduce((sum, a) => sum + a.equity, 0);
      }
    }

    const baseEquity = lastRecordedEquity ?? currentEquity;
    const totalPnl = currentEquity - baseEquity;
    const totalReturn = baseEquity > 0 ? (totalPnl / baseEquity) * 100 : 0;
    lastRecordedEquity = currentEquity;

    const now = new Date();
    const snapshot: PerformanceSnapshot = {
      id: `perf-${now.toISOString().slice(0, 10)}-${Date.now()}`,
      period: now.toISOString().slice(0, 10),
      periodType: "daily",
      totalPnl,
      totalReturn,
      sharpe: null,
      maxDrawdown: null,
      byStrategyJson: null,
      byMarketJson: null,
      bySymbolJson: null,
      createdAt: Date.now(),
    };

    perfStore.addSnapshot(snapshot);
  }

  // ── fin_fund_status ──

  api.registerTool(
    {
      name: "fin_fund_status",
      label: "Fund Status",
      description:
        "View fund portfolio status — total equity, allocations, risk level, strategy count",
      parameters: Type.Object({}),
      async execute() {
        const state = manager.getState();
        const registry = getRegistry();
        const strategies = registry?.list() ?? [];
        const totalEquity = config.totalCapital ?? state.totalCapital;

        const risk = manager.evaluateRisk(totalEquity);

        return json({
          totalCapital: state.totalCapital,
          totalEquity,
          allocations: state.allocations,
          allocationCount: state.allocations.length,
          totalStrategies: strategies.length,
          byLevel: {
            L0_INCUBATE: strategies.filter((s) => s.level === "L0_INCUBATE").length,
            L1_BACKTEST: strategies.filter((s) => s.level === "L1_BACKTEST").length,
            L2_PAPER: strategies.filter((s) => s.level === "L2_PAPER").length,
            L3_LIVE: strategies.filter((s) => s.level === "L3_LIVE").length,
            KILLED: strategies.filter((s) => s.level === "KILLED").length,
          },
          risk,
          lastRebalanceAt: state.lastRebalanceAt
            ? new Date(state.lastRebalanceAt).toISOString()
            : "never",
        });
      },
    },
    { names: ["fin_fund_status"] },
  );

  // ── fin_fund_allocate ──

  api.registerTool(
    {
      name: "fin_fund_allocate",
      label: "Fund Allocate",
      description:
        "Compute capital allocations for active strategies using Half-Kelly with constraints",
      parameters: Type.Object({}),
      async execute() {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const records = registry.list() as Parameters<typeof manager.buildProfiles>[0];
        const profiles = manager.buildProfiles(records);
        const allocations = manager.allocate(profiles);

        return json({
          allocations,
          totalAllocated: allocations.reduce((sum, a) => sum + a.capitalUsd, 0),
          cashReserve:
            (config.totalCapital ?? manager.getState().totalCapital) -
            allocations.reduce((sum, a) => sum + a.capitalUsd, 0),
        });
      },
    },
    { names: ["fin_fund_allocate"] },
  );

  // ── fin_fund_rebalance ──

  api.registerTool(
    {
      name: "fin_fund_rebalance",
      label: "Fund Rebalance",
      description:
        "Execute full rebalance: re-profile strategies, compute correlations, re-allocate, check promotions/demotions",
      parameters: Type.Object({
        confirmed_promotions: Type.Optional(
          Type.Array(Type.String(), {
            description: "Strategy IDs confirmed by user for L3 promotion",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const records = registry.list() as Parameters<typeof manager.buildProfiles>[0];

        // Gather paper trading data if available
        const paper = getPaper();
        const paperData = new Map<
          string,
          {
            metrics?: ReturnType<typeof manager.buildProfiles> extends Array<infer P>
              ? P extends { paperMetrics?: infer M }
                ? M
                : never
              : never;
            equity?: number;
            initialCapital?: number;
            daysActive?: number;
            tradeCount?: number;
          }
        >();

        if (paper) {
          const accounts = paper.listAccounts();
          for (const acct of accounts) {
            const state = paper.getAccountState(acct.id);
            if (!state) continue;
            const metrics = paper.getMetrics(acct.id);
            const strategyIds = new Set(
              state.orders
                .filter((o: { strategyId?: string }) => o.strategyId)
                .map((o: { strategyId?: string }) => o.strategyId!),
            );
            for (const sid of strategyIds) {
              paperData.set(sid, {
                metrics: metrics as ReturnType<
                  typeof manager.buildProfiles
                >[number]["paperMetrics"],
                equity: state.equity,
                initialCapital: state.initialCapital,
                daysActive: Math.floor((Date.now() - state.createdAt) / 86_400_000),
                tradeCount: state.orders.filter(
                  (o: { strategyId?: string }) => o.strategyId === sid,
                ).length,
              });
            }
          }
        }

        const result = manager.rebalance(records, paperData);

        // Apply promotions/demotions to the registry
        const confirmedSet = new Set((params.confirmed_promotions as string[] | undefined) ?? []);
        const pendingConfirmations: PromotionCheck[] = [];

        for (const promo of result.promotions) {
          if (promo.targetLevel) {
            if (promo.targetLevel === "L3_LIVE" && !confirmedSet.has(promo.strategyId)) {
              pendingConfirmations.push({
                ...promo,
                needsUserConfirmation: true,
              });
              continue;
            }
            try {
              registry.updateLevel(promo.strategyId, promo.targetLevel);
            } catch {
              // Strategy may not exist
            }
          }
        }
        for (const demo of result.demotions) {
          if (demo.targetLevel) {
            try {
              registry.updateLevel(demo.strategyId, demo.targetLevel);
            } catch {
              // Strategy may not exist
            }
          }
        }

        // Record capital flows for the rebalance
        for (const alloc of result.allocations) {
          flowStore.record({
            id: `rebalance-${Date.now()}-${alloc.strategyId}`,
            type: "transfer",
            amount: alloc.capitalUsd,
            currency: "USD",
            status: "completed",
            description: `Rebalance allocation to ${alloc.strategyId} (${alloc.weightPct.toFixed(1)}%)`,
            createdAt: Date.now(),
          });
        }

        // Record daily performance snapshot after rebalance
        recordDailySnapshot();

        return json({
          allocations: result.allocations,
          leaderboard: result.leaderboard,
          risk: result.risk,
          promotions: result.promotions,
          demotions: result.demotions,
          pendingConfirmations,
        });
      },
    },
    { names: ["fin_fund_rebalance"] },
  );

  // ── fin_leaderboard ──

  api.registerTool(
    {
      name: "fin_leaderboard",
      label: "Strategy Leaderboard",
      description: "View strategy leaderboard ranked by confidence-adjusted fitness score",
      parameters: Type.Object({
        level: Type.Optional(
          Type.Unsafe<string>({
            type: "string",
            enum: ["L1_BACKTEST", "L2_PAPER", "L3_LIVE"],
            description: "Filter by strategy level",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const filter = params.level ? { level: params.level as string } : undefined;
        const records = registry.list(filter) as Parameters<typeof manager.buildProfiles>[0];
        const profiles = manager.buildProfiles(records);
        const lb = manager.getLeaderboard(profiles);

        return json({ leaderboard: lb, total: lb.length });
      },
    },
    { names: ["fin_leaderboard"] },
  );

  // ── fin_fund_promote ──

  api.registerTool(
    {
      name: "fin_fund_promote",
      label: "Check Promotion",
      description: "Check if a strategy is eligible for promotion to the next level",
      parameters: Type.Object({
        strategyId: Type.String({ description: "Strategy ID to check" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const strategyId = params.strategyId as string;
        const record = registry.get(strategyId) as
          | Parameters<typeof manager.buildProfiles>[0][number]
          | undefined;
        if (!record) return json({ error: `Strategy ${strategyId} not found` });

        const profiles = manager.buildProfiles([record]);
        if (profiles.length === 0) return json({ error: "Could not build profile" });

        const check = manager.checkPromotion(profiles[0]!);
        return json(check);
      },
    },
    { names: ["fin_fund_promote"] },
  );

  // ── fin_fund_risk ──

  api.registerTool(
    {
      name: "fin_fund_risk",
      label: "Fund Risk",
      description: "Evaluate fund-level risk status including daily drawdown and exposure",
      parameters: Type.Object({}),
      async execute() {
        const totalEquity = config.totalCapital ?? manager.getState().totalCapital;
        const risk = manager.evaluateRisk(totalEquity);
        const scaleFactor = manager.riskManager.getScaleFactor(risk.riskLevel);

        return json({
          ...risk,
          scaleFactor,
          actions: getActionRecommendations(risk.riskLevel),
        });
      },
    },
    { names: ["fin_fund_risk"] },
  );

  // ── fin_list_promotions_ready ──

  api.registerTool(
    {
      name: "fin_list_promotions_ready",
      label: "Promotions Ready",
      description: "List all strategies eligible for promotion, with confirmation requirements",
      parameters: Type.Object({
        level: Type.Optional(
          Type.Unsafe<string>({
            type: "string",
            enum: ["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER"],
            description: "Filter by current level",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const level = params.level as string | undefined;
        const strategies = registry.list(level ? { level } : undefined);
        const records = strategies as Parameters<typeof manager.buildProfiles>[0];
        const profiles = manager.buildProfiles(records);

        const promotions = profiles.map((p) => manager.checkPromotion(p)).filter((c) => c.eligible);

        return json({
          promotions,
          summary: {
            total: profiles.length,
            eligible: promotions.length,
            needsConfirmation: promotions.filter((p) => p.needsUserConfirmation).length,
            autoPromote: promotions.filter((p) => !p.needsUserConfirmation).length,
          },
        });
      },
    },
    { names: ["fin_list_promotions_ready"] },
  );

  // ── fin_strategy_tick ──

  api.registerTool(
    {
      name: "fin_strategy_tick",
      label: "Strategy Tick",
      description:
        "Drive strategy execution: fetch latest candles, run onBar() for L2 (paper) and L3 (live) strategies, place orders, record snapshots. " +
        "Omit strategyId to tick all running strategies. Set dryRun=true to compute signals without placing orders.",
      parameters: Type.Object({
        strategyId: Type.Optional(
          Type.String({ description: "Strategy ID to tick. Omit to tick all L2+L3 strategies." }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "If true, compute signals but do not place orders (default: false)",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const dataProvider = deps.getDataProvider?.();
        if (!dataProvider)
          return json({ error: "Data provider not available (findoo-datahub-plugin not loaded)" });

        const paper = getPaper();
        const liveExecutor = deps.getLiveExecutor?.();
        const regimeDetector = deps.getRegimeDetector?.();
        const dryRun = params.dryRun === true;

        // Select strategies to tick
        const targetId = params.strategyId as string | undefined;
        const allStrategies = registry.list();
        const strategies = allStrategies.filter((s) => {
          if (targetId && s.id !== targetId) return false;
          return s.level === "L2_PAPER" || s.level === "L3_LIVE";
        });

        if (strategies.length === 0) {
          return json({
            ticked: 0,
            signals: [],
            snapshots: 0,
            note: targetId
              ? `Strategy ${targetId} not found or not at L2/L3 level`
              : "No L2_PAPER or L3_LIVE strategies found",
          });
        }

        const signals: Array<{
          strategyId: string;
          strategyName: string;
          level: string;
          symbol: string;
          action: string;
          confidence: number;
          reason: string;
          orderResult?: Record<string, unknown>;
        }> = [];
        let tickedCount = 0;
        let snapshotCount = 0;
        const errors: string[] = [];

        for (const record of strategies) {
          try {
            const def = record.definition;
            if (typeof def.onBar !== "function") {
              errors.push(`${record.id}: onBar not a function (strategy not hydrated)`);
              continue;
            }

            const symbol = def.symbols[0] ?? "BTC/USDT";
            const timeframe = def.timeframes[0] ?? "1h";
            const market = def.markets[0] ?? "crypto";

            const ohlcv = await dataProvider.getOHLCV({ symbol, market, timeframe, limit: 200 });
            if (!ohlcv || ohlcv.length === 0) {
              errors.push(`${record.id}: no OHLCV data for ${symbol} ${timeframe}`);
              continue;
            }

            const latestBar = ohlcv[ohlcv.length - 1]!;
            const indicators = buildIndicatorLib(ohlcv);

            // Build portfolio context from paper account
            let portfolio = {
              equity: 10000,
              cash: 10000,
              positions: [] as Array<Record<string, unknown>>,
            };
            let activeAccountId: string | undefined;
            if (paper) {
              const accounts = paper.listAccounts();
              activeAccountId = accounts[0]?.id;
              if (activeAccountId) {
                const state = paper.getAccountState(activeAccountId);
                if (state) {
                  portfolio = {
                    equity: state.equity,
                    cash: state.cash ?? state.equity,
                    positions: state.positions ?? [],
                  };
                }
              }
            }

            const ctx: StrategyContext = {
              portfolio: {
                equity: portfolio.equity,
                cash: portfolio.cash,
                positions: [],
              },
              history: ohlcv,
              indicators,
              regime: (regimeDetector?.detect(ohlcv) ?? "sideways") as StrategyContext["regime"],
              memory: new Map(),
              log: () => {},
            };

            const signal: Signal | null = await def.onBar(latestBar, ctx);
            tickedCount++;

            if (!signal) continue;

            const signalEntry: (typeof signals)[number] = {
              strategyId: record.id,
              strategyName: record.name,
              level: record.level,
              symbol: signal.symbol || symbol,
              action: signal.action,
              confidence: signal.confidence,
              reason: signal.reason,
            };

            if (!dryRun) {
              const quantity = ((signal.sizePct / 100) * ctx.portfolio.equity) / latestBar.close;

              if (record.level === "L2_PAPER" && paper && activeAccountId) {
                // Paper trading
                const orderResult = paper.submitOrder(
                  activeAccountId,
                  {
                    symbol: signal.symbol || symbol,
                    side: signal.action === "buy" ? "buy" : "sell",
                    type: signal.orderType,
                    quantity,
                    strategyId: record.id,
                    reason: signal.reason,
                  },
                  latestBar.close,
                );
                signalEntry.orderResult = orderResult as Record<string, unknown>;
              } else if (record.level === "L3_LIVE" && liveExecutor) {
                // Live trading — risk gate is handled by before_tool_call hook
                try {
                  const orderResult = await liveExecutor.placeOrder({
                    symbol: signal.symbol || symbol,
                    side: signal.action === "buy" ? "buy" : "sell",
                    type: signal.orderType,
                    amount: quantity,
                    price: signal.limitPrice,
                  });
                  signalEntry.orderResult = orderResult as Record<string, unknown>;
                } catch (err) {
                  signalEntry.orderResult = {
                    error: err instanceof Error ? err.message : String(err),
                  };
                }
              }
            }

            signals.push(signalEntry);
          } catch (err) {
            errors.push(`${record.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Record snapshots for paper accounts
        if (!dryRun && paper) {
          const accounts = paper.listAccounts();
          for (const acct of accounts) {
            try {
              paper.recordSnapshot(acct.id);
              snapshotCount++;
            } catch {
              // non-critical
            }
          }
        }

        return json({
          ticked: tickedCount,
          signals,
          snapshots: snapshotCount,
          dryRun,
          ...(errors.length > 0 ? { errors } : {}),
        });
      },
    },
    { names: ["fin_strategy_tick"] },
  );

  // ── fin_lifecycle_scan ──

  api.registerTool(
    {
      name: "fin_lifecycle_scan",
      label: "Lifecycle Scan",
      description:
        "Scan all strategies for lifecycle actions: promotions ready, demotions needed, health alerts. Returns structured action list for autonomous decision-making.",
      parameters: Type.Object({}),
      async execute() {
        const registry = getRegistry();
        if (!registry) return json({ error: "Strategy registry not available" });

        const records = registry.list() as Parameters<typeof manager.buildProfiles>[0];
        const profiles = manager.buildProfiles(records);
        const paper = getPaper();

        const actions: Array<{
          strategyId: string;
          strategyName: string;
          currentLevel: string;
          action: string;
          detail: string;
          tool: string;
        }> = [];

        for (const profile of profiles) {
          const record = records.find((r) => r.id === profile.id);
          if (!record) continue;

          const check = manager.checkPromotion(profile);

          // Promotion ready
          if (check.eligible && check.targetLevel) {
            actions.push({
              strategyId: profile.id,
              strategyName: record.name,
              currentLevel: record.level,
              action: check.needsUserConfirmation ? "approve_promotion" : "promote",
              detail: `Eligible for ${check.targetLevel}${check.needsUserConfirmation ? " (needs user confirmation)" : ""}`,
              tool: check.needsUserConfirmation
                ? "fin_fund_rebalance with confirmed_promotions"
                : "fin_fund_rebalance",
            });
          }

          // Needs backtest
          if (record.level === "L1_BACKTEST" && !record.lastBacktest) {
            actions.push({
              strategyId: profile.id,
              strategyName: record.name,
              currentLevel: record.level,
              action: "run_backtest",
              detail: "No backtest results yet — run backtest to evaluate",
              tool: "fin_backtest_run",
            });
          }

          // Health check for paper trading strategies
          if (record.level === "L2_PAPER" && paper) {
            const metrics = paper.getMetrics("default") as {
              maxDrawdown?: number;
              sharpe?: number;
            } | null;
            if (metrics?.maxDrawdown && metrics.maxDrawdown < -20) {
              actions.push({
                strategyId: profile.id,
                strategyName: record.name,
                currentLevel: record.level,
                action: "review_health",
                detail: `Paper drawdown ${metrics.maxDrawdown.toFixed(1)}% — consider demotion`,
                tool: "fin_fund_rebalance",
              });
            }
          }
        }

        // Sort: approve_promotion first, then promote, then others
        const priority: Record<string, number> = {
          approve_promotion: 0,
          promote: 1,
          review_health: 2,
          run_backtest: 3,
        };
        actions.sort((a, b) => (priority[a.action] ?? 9) - (priority[b.action] ?? 9));

        const totalEquity = config.totalCapital ?? manager.getState().totalCapital;
        const risk = manager.evaluateRisk(totalEquity);

        return json({
          actions,
          summary: {
            totalStrategies: records.length,
            actionableCount: actions.length,
            riskLevel: risk.riskLevel,
          },
        });
      },
    },
    { names: ["fin_lifecycle_scan"] },
  );
}

function getActionRecommendations(level: string): string[] {
  switch (level) {
    case "critical":
      return ["HALT all trading immediately", "Notify user", "Close risky positions"];
    case "warning":
      return ["Shrink all positions by 50%", "No new entries", "Monitor closely"];
    case "caution":
      return ["Reduce new position sizes by 20%", "Tighten stop losses"];
    case "normal":
      return ["Normal operations"];
    default:
      return [];
  }
}
