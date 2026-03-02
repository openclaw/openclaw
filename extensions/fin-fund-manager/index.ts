import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { CapitalFlowStore } from "./src/capital-flow-store.js";
import {
  formatFundStatus,
  formatRiskStatus,
  formatLeaderboard,
  formatAllocations,
  formatPromoteCheck,
} from "./src/formatters.js";
import { FundManager } from "./src/fund-manager.js";
import {
  PerformanceSnapshotStore,
  type PerformanceSnapshot,
} from "./src/performance-snapshot-store.js";
import type { FundConfig, LeaderboardEntry, PromotionCheck } from "./src/types.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const plugin = {
  id: "fin-fund-manager",
  name: "Fund Manager",
  description:
    "Fund portfolio management — capital allocation, risk control, leaderboard, promotion pipeline",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const financialConfig = (api.config as Record<string, unknown>)?.financial as
      | Record<string, unknown>
      | undefined;
    const fundCfg = (financialConfig?.fund ?? {}) as Partial<FundConfig>;

    const config: FundConfig = {
      totalCapital: fundCfg.totalCapital,
      cashReservePct: fundCfg.cashReservePct ?? 30,
      maxSingleStrategyPct: fundCfg.maxSingleStrategyPct ?? 30,
      maxTotalExposurePct: fundCfg.maxTotalExposurePct ?? 70,
      rebalanceFrequency: fundCfg.rebalanceFrequency ?? "weekly",
    };

    const statePath = api.resolvePath("state/fin-fund-state.json");
    const manager = new FundManager(statePath, config);
    const perfStore = new PerformanceSnapshotStore(
      api.resolvePath("state/fin-performance-snapshots.sqlite"),
    );
    const flowStore = new CapitalFlowStore(api.resolvePath("state/fin-capital-flows.sqlite"));

    // Track the previous equity to compute PnL across rebalances
    let lastRecordedEquity: number | null = null;

    /** Record a daily performance snapshot after rebalance. */
    function recordDailySnapshot(): void {
      // Gather current equity from paper accounts, fall back to configured capital
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
        sharpe: null, // computed later by analytics
        maxDrawdown: null, // computed later by analytics
        byStrategyJson: null,
        byMarketJson: null,
        bySymbolJson: null,
        createdAt: Date.now(),
      };

      perfStore.addSnapshot(snapshot);
    }

    // Register service
    api.registerService({
      id: "fin-fund-manager",
      instance: manager,
      start() {
        const equity = config.totalCapital ?? 100000;
        manager.markDayStart(equity);
      },
    } as Parameters<typeof api.registerService>[0]);

    // Access strategy registry and paper engine from other services
    const runtime = api.runtime as unknown as { services?: Map<string, unknown> };

    type RegistryLike = {
      list: (filter?: { level?: string }) => Array<{
        id: string;
        name: string;
        version: string;
        level: string;
        definition: unknown;
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
        orders: Array<{ strategyId?: string }>;
        createdAt: number;
      } | null;
      getMetrics: (id: string) => unknown;
    };

    const getRegistry = (): RegistryLike | undefined =>
      runtime.services?.get?.("fin-strategy-registry") as RegistryLike | undefined;

    const getPaper = (): PaperLike | undefined =>
      runtime.services?.get?.("fin-paper-engine") as PaperLike | undefined;

    // --- Tools ---

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
              // Find strategyId from orders
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
              // L2→L3 needs user confirmation
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
          const strategies = registry.list(level ? { level: level as "L0_INCUBATE" } : undefined);
          const records = strategies as Parameters<typeof manager.buildProfiles>[0];
          const profiles = manager.buildProfiles(records);

          const promotions = profiles
            .map((p) => manager.checkPromotion(p))
            .filter((c) => c.eligible);

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

    // ── Helper: gather status data shared by commands + HTTP routes ──

    function gatherFundStatusData() {
      const state = manager.getState();
      const registry = getRegistry();
      const strategies = registry?.list() ?? [];
      const totalEquity = config.totalCapital ?? state.totalCapital;
      const risk = manager.evaluateRisk(totalEquity);

      return {
        totalEquity,
        todayPnl: risk.todayPnl,
        todayPnlPct: risk.todayPnlPct,
        riskLevel: risk.riskLevel,
        dailyDrawdown: risk.dailyDrawdown,
        byLevel: {
          L3_LIVE: strategies.filter((s) => s.level === "L3_LIVE").length,
          L2_PAPER: strategies.filter((s) => s.level === "L2_PAPER").length,
          L1_BACKTEST: strategies.filter((s) => s.level === "L1_BACKTEST").length,
          L0_INCUBATE: strategies.filter((s) => s.level === "L0_INCUBATE").length,
          KILLED: strategies.filter((s) => s.level === "KILLED").length,
        },
        allocationCount: state.allocations.length,
        lastRebalanceAt: state.lastRebalanceAt
          ? new Date(state.lastRebalanceAt).toISOString()
          : "never",
        risk,
        state,
        strategies,
      };
    }

    function gatherLeaderboard(): LeaderboardEntry[] {
      const registry = getRegistry();
      if (!registry) return [];
      const records = registry.list() as Parameters<typeof manager.buildProfiles>[0];
      const profiles = manager.buildProfiles(records);
      return manager.getLeaderboard(profiles);
    }

    // ── Bot Commands ──

    api.registerCommand({
      name: "fund",
      description: "View fund portfolio status",
      acceptsArgs: false,
      handler: async () => {
        const data = gatherFundStatusData();
        return { text: formatFundStatus(data) };
      },
    });

    api.registerCommand({
      name: "risk",
      description: "View fund risk status",
      acceptsArgs: false,
      handler: async () => {
        const totalEquity = config.totalCapital ?? manager.getState().totalCapital;
        const risk = manager.evaluateRisk(totalEquity);
        const scaleFactor = manager.riskManager.getScaleFactor(risk.riskLevel);
        const actions = getActionRecommendations(risk.riskLevel);
        return { text: formatRiskStatus(risk, scaleFactor, actions) };
      },
    });

    api.registerCommand({
      name: "lb",
      description: "View strategy leaderboard",
      acceptsArgs: false,
      handler: async () => {
        const lb = gatherLeaderboard();
        return { text: formatLeaderboard(lb) };
      },
    });

    api.registerCommand({
      name: "alloc",
      description: "View current capital allocations",
      acceptsArgs: false,
      handler: async () => {
        const state = manager.getState();
        const totalCapital = config.totalCapital ?? state.totalCapital;
        return { text: formatAllocations(state.allocations, totalCapital) };
      },
    });

    api.registerCommand({
      name: "promote",
      description: "Check strategy promotion eligibility",
      acceptsArgs: true,
      handler: async (ctx) => {
        const strategyId = ctx.args?.trim();
        if (!strategyId) {
          return { text: "Usage: /promote <strategyId>" };
        }
        const registry = getRegistry();
        if (!registry) {
          return { text: "Strategy registry not available" };
        }
        const record = registry.get(strategyId) as
          | Parameters<typeof manager.buildProfiles>[0][number]
          | undefined;
        if (!record) {
          return { text: `Strategy ${strategyId} not found` };
        }
        const profiles = manager.buildProfiles([record]);
        if (profiles.length === 0) {
          return { text: "Could not build profile" };
        }
        const check = manager.checkPromotion(profiles[0]!) as PromotionCheck;
        return { text: formatPromoteCheck(check) };
      },
    });

    // ── Helper: gather full fund data for dashboard + SSE ──

    function gatherFullFundData() {
      const data = gatherFundStatusData();
      const lb = gatherLeaderboard();
      const totalCapital = config.totalCapital ?? data.state.totalCapital;
      const totalAllocated = data.state.allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
      const scaleFactor = manager.riskManager.getScaleFactor(data.risk.riskLevel);

      return {
        status: {
          totalEquity: data.totalEquity,
          todayPnl: data.todayPnl,
          todayPnlPct: data.todayPnlPct,
          riskLevel: data.riskLevel,
          dailyDrawdown: data.dailyDrawdown,
          byLevel: data.byLevel,
          lastRebalanceAt: data.lastRebalanceAt,
        },
        leaderboard: lb,
        allocations: {
          items: data.state.allocations,
          totalAllocated,
          cashReserve: totalCapital - totalAllocated,
          totalCapital,
        },
        risk: {
          ...data.risk,
          scaleFactor,
          maxAllowedDrawdown: data.risk.maxAllowedDrawdown,
        },
        latestPerformance: perfStore.getLatest("daily", 7),
        recentFlows: flowStore.list(10),
      };
    }

    // ── HTTP REST Routes ──

    api.registerHttpRoute({
      path: "/api/v1/fund/status",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const data = gatherFundStatusData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            totalEquity: data.totalEquity,
            todayPnl: data.todayPnl,
            todayPnlPct: data.todayPnlPct,
            riskLevel: data.riskLevel,
            dailyDrawdown: data.dailyDrawdown,
            byLevel: data.byLevel,
            allocationCount: data.allocationCount,
            lastRebalanceAt: data.lastRebalanceAt,
          }),
        );
      },
    });

    api.registerHttpRoute({
      path: "/api/v1/fund/leaderboard",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const lb = gatherLeaderboard();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ leaderboard: lb, total: lb.length }));
      },
    });

    api.registerHttpRoute({
      path: "/api/v1/fund/risk",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const totalEquity = config.totalCapital ?? manager.getState().totalCapital;
        const risk = manager.evaluateRisk(totalEquity);
        const scaleFactor = manager.riskManager.getScaleFactor(risk.riskLevel);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ...risk,
            scaleFactor,
            actions: getActionRecommendations(risk.riskLevel),
          }),
        );
      },
    });

    api.registerHttpRoute({
      path: "/api/v1/fund/allocations",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const state = manager.getState();
        const totalCapital = config.totalCapital ?? state.totalCapital;
        const totalAllocated = state.allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            allocations: state.allocations,
            totalAllocated,
            cashReserve: totalCapital - totalAllocated,
            totalCapital,
          }),
        );
      },
    });

    // ── Performance Snapshots API ──

    api.registerHttpRoute({
      path: "/api/v1/fund/performance",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const snapshots = perfStore.getLatest("daily", 30);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ snapshots, total: snapshots.length }));
      },
    });

    // ── Capital Flows API ──

    api.registerHttpRoute({
      path: "/api/v1/fund/capital-flows",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const flows = flowStore.list(50);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ flows, total: flows.length }));
      },
    });

    // ── SSE Stream ──

    api.registerHttpRoute({
      path: "/api/v1/fund/stream",
      handler: async (
        req: { on: (event: string, cb: () => void) => void },
        res: {
          writeHead: (statusCode: number, headers: Record<string, string>) => void;
          write: (chunk: string) => boolean;
          end: (body?: string) => void;
        },
      ) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(gatherFullFundData())}\n\n`);
        const interval = setInterval(() => {
          res.write(`data: ${JSON.stringify(gatherFullFundData())}\n\n`);
        }, 10000);
        req.on("close", () => clearInterval(interval));
      },
    });

    // ── CLI Commands ──

    api.registerCli(({ program }) => {
      const fund = program.command("fund").description("Fund management commands");

      fund
        .command("pipeline")
        .description("Run full trading pipeline: backtest → walk-forward → paper trade")
        .option("--live", "Include real testnet orders via CcxtBridge")
        .action(async (opts: { live?: boolean }) => {
          const registrySvc = getRegistry();
          const paperSvc = getPaper();

          if (!registrySvc) {
            console.log(
              "Strategy registry not available. Ensure fin-strategy-engine plugin is enabled.",
            );
            return;
          }
          if (!paperSvc) {
            console.log("Paper engine not available. Ensure fin-paper-trading plugin is enabled.");
            return;
          }

          console.log("\nOpenFinClaw Fund Pipeline");
          console.log(`Mode: ${opts.live ? "LIVE (testnet)" : "Paper-only"}\n`);

          // List strategies and their levels
          const strategies = registrySvc.list();
          console.log(`Strategies registered: ${strategies.length}`);
          for (const s of strategies) {
            const bt = (s as { lastBacktest?: { totalReturn: number; sharpe: number } })
              .lastBacktest;
            const btInfo = bt
              ? `return=${bt.totalReturn.toFixed(2)}% sharpe=${bt.sharpe.toFixed(3)}`
              : "no backtest";
            console.log(`  ${s.id} [${s.level}] — ${btInfo}`);
          }

          // Show paper accounts
          const accounts = paperSvc.listAccounts();
          console.log(`\nPaper accounts: ${accounts.length}`);
          for (const a of accounts) {
            console.log(`  ${a.id}: ${a.name} — $${a.equity.toFixed(2)}`);
          }

          // Rebalance if fund manager is available
          const profiles = manager.buildProfiles(
            strategies as Parameters<typeof manager.buildProfiles>[0],
          );
          const allocations = manager.allocate(profiles);

          console.log(`\nAllocations (${allocations.length}):`);
          for (const a of allocations) {
            console.log(
              `  ${a.strategyId}: $${a.capitalUsd.toFixed(2)} (${a.weightPct.toFixed(1)}%)`,
            );
          }

          // Risk evaluation
          const totalEquity = config.totalCapital ?? manager.getState().totalCapital;
          const risk = manager.evaluateRisk(totalEquity);
          console.log(`\nRisk: ${risk.riskLevel} (DD: ${risk.dailyDrawdown.toFixed(1)}%)`);

          if (opts.live) {
            console.log("\nLive testnet orders require the standalone script:");
            console.log("  bun scripts/finance/run-trading-pipeline.ts --live");
          }

          console.log("\nPipeline complete.");
        });
    });

    // ── Dashboard Route ──

    api.registerHttpRoute({
      path: "/dashboard/fund",
      handler: async (
        _req: unknown,
        res: {
          writeHead: (s: number, h: Record<string, string>) => void;
          end: (b: string) => void;
        },
      ) => {
        const fundData = gatherFullFundData();

        let html: string;
        try {
          const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
          const template = readFileSync(join(dashboardDir, "fund-dashboard.html"), "utf-8");
          const css = readFileSync(join(dashboardDir, "fund-dashboard.css"), "utf-8");
          // Escape </script> in JSON to prevent XSS
          const safeJson = JSON.stringify(fundData).replace(/<\//g, "<\\/");
          html = template.replace("/*__FUND_CSS__*/", css).replace("/*__FUND_DATA__*/{}", safeJson);
        } catch {
          // Fallback: return JSON data if template not found
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(fundData));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      },
    });
  },
};

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

export default plugin;
