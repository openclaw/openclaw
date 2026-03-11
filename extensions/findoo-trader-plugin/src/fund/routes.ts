import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { CapitalFlowStore } from "./capital-flow-store.js";
import {
  formatFundStatus,
  formatRiskStatus,
  formatLeaderboard,
  formatAllocations,
  formatPromoteCheck,
} from "./formatters.js";
import type { FundManager } from "./fund-manager.js";
import type { PerformanceSnapshotStore } from "./performance-snapshot-store.js";
import type { FundConfig, LeaderboardEntry, PromotionCheck } from "./types.js";

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

export type FundRouteDeps = {
  manager: FundManager;
  config: FundConfig;
  flowStore: CapitalFlowStore;
  perfStore: PerformanceSnapshotStore;
  getRegistry: () => RegistryLike | undefined;
  getPaper: () => PaperLike | undefined;
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

export function registerFundRoutes(api: OpenClawPluginApi, deps: FundRouteDeps): void {
  const { manager, config, flowStore, perfStore, getRegistry, getPaper } = deps;

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

  // ── HTTP REST Routes ──

  api.registerHttpRoute({
    auth: "plugin",
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
    auth: "plugin",
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
    auth: "plugin",
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
    auth: "plugin",
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
    auth: "plugin",
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
    auth: "plugin",
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
    auth: "plugin",
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

        const strategies = registrySvc.list();
        console.log(`Strategies registered: ${strategies.length}`);
        for (const s of strategies) {
          const bt = (s as { lastBacktest?: { totalReturn: number; sharpe: number } }).lastBacktest;
          const btInfo = bt
            ? `return=${bt.totalReturn.toFixed(2)}% sharpe=${bt.sharpe.toFixed(3)}`
            : "no backtest";
          console.log(`  ${s.id} [${s.level}] — ${btInfo}`);
        }

        const accounts = paperSvc.listAccounts();
        console.log(`\nPaper accounts: ${accounts.length}`);
        for (const a of accounts) {
          console.log(`  ${a.id}: ${a.name} — $${a.equity.toFixed(2)}`);
        }

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
    auth: "plugin",
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
        const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "../../dashboard");
        const template = readFileSync(join(dashboardDir, "fund-dashboard.html"), "utf-8");
        const css = readFileSync(join(dashboardDir, "fund-dashboard.css"), "utf-8");
        const safeJson = JSON.stringify(fundData).replace(/<\//g, "<\\/");
        html = template
          .replace("/*__FUND_CSS__*/", css)
          .replace(/\/\*__FUND_DATA__\*\/\s*\{\}/, safeJson);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(fundData));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });
}
