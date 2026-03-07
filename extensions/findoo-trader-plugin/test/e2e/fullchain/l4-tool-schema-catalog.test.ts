/**
 * L4 — Tool Schema Catalog: validates all 25 fin_* tools are registered
 * with complete schema metadata (name, label, description, parameters).
 *
 * Zero LLM cost — uses mock api.registerTool() to capture tool definitions.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-tool-schema-catalog.test.ts
 */
vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeRegistry } from "../../../src/core/exchange-registry.js";
import { RiskController } from "../../../src/core/risk-controller.js";
import { registerTradingTools } from "../../../src/execution/trading-tools.js";
import { CapitalFlowStore } from "../../../src/fund/capital-flow-store.js";
import { FundManager } from "../../../src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "../../../src/fund/performance-snapshot-store.js";
import { registerFundTools } from "../../../src/fund/tools.js";
import { PaperEngine } from "../../../src/paper/paper-engine.js";
import { PaperStore } from "../../../src/paper/paper-store.js";
import { registerPaperTools } from "../../../src/paper/tools.js";
import { RemoteBacktestBridge } from "../../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../../src/strategy/tools.js";

// ── Types ──

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
};

type RegisterToolCall = {
  def: ToolDef;
  opts: { names: string[] };
};

// ── Helpers ──

function createCaptureMockApi() {
  const calls: RegisterToolCall[] = [];
  const api = {
    registerTool: vi.fn((def: ToolDef, opts: { names: string[] }) => {
      calls.push({ def, opts });
    }),
    runtime: { services: new Map() },
  };
  return { api, calls };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l4-schema-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Expected tool catalog ──

const STRATEGY_TOOLS = [
  "fin_strategy_create",
  "fin_strategy_list",
  "fin_backtest_run",
  "fin_backtest_result",
  "fin_walk_forward_run",
];

const PAPER_TOOLS = [
  "fin_paper_create",
  "fin_paper_order",
  "fin_paper_positions",
  "fin_paper_state",
  "fin_paper_metrics",
  "fin_paper_list",
];

const FUND_TOOLS = [
  "fin_fund_status",
  "fin_fund_allocate",
  "fin_fund_rebalance",
  "fin_leaderboard",
  "fin_fund_promote",
  "fin_fund_risk",
  "fin_list_promotions_ready",
  "fin_lifecycle_scan",
  "fin_strategy_tick",
];

const EXECUTION_TOOLS = [
  "fin_place_order",
  "fin_cancel_order",
  "fin_modify_order",
  "fin_set_stop_loss",
  "fin_set_take_profit",
];

const ALL_TOOLS = [...STRATEGY_TOOLS, ...PAPER_TOOLS, ...FUND_TOOLS, ...EXECUTION_TOOLS];

// ── Tests ──

describe("L4 — Tool Schema Catalog", () => {
  describe("Strategy tools (5)", () => {
    let calls: RegisterToolCall[];

    beforeEach(() => {
      const { api, calls: c } = createCaptureMockApi();
      calls = c;
      const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
      const bridge = new RemoteBacktestBridge(() => undefined);
      registerStrategyTools(api as never, registry, bridge, null, null);
    });

    it("registers exactly 5 strategy tools", () => {
      const names = calls.flatMap((c) => c.opts.names);
      expect(names).toEqual(expect.arrayContaining(STRATEGY_TOOLS));
      expect(names).toHaveLength(5);
    });

    for (const toolName of STRATEGY_TOOLS) {
      it(`${toolName}: has name, description, label, and parameters`, () => {
        const call = calls.find((c) => c.opts.names.includes(toolName));
        expect(call).toBeDefined();
        const def = call!.def;
        expect(def.name).toBe(toolName);
        expect(typeof def.description).toBe("string");
        expect(def.description!.length).toBeGreaterThan(5);
        expect(typeof def.label).toBe("string");
        expect(def.label!.length).toBeGreaterThan(0);
        expect(def.parameters).toBeDefined();
        expect(typeof def.parameters).toBe("object");
      });
    }
  });

  describe("Paper tools (6)", () => {
    let calls: RegisterToolCall[];

    beforeEach(() => {
      const { api, calls: c } = createCaptureMockApi();
      calls = c;
      const store = new PaperStore(join(tmpDir, "paper.sqlite"));
      const engine = new PaperEngine({ store, slippageBps: 5, market: "crypto" });
      registerPaperTools(api as never, engine);
    });

    it("registers exactly 6 paper tools", () => {
      const names = calls.flatMap((c) => c.opts.names);
      expect(names).toEqual(expect.arrayContaining(PAPER_TOOLS));
      expect(names).toHaveLength(6);
    });

    for (const toolName of PAPER_TOOLS) {
      it(`${toolName}: has name, description, label, and parameters`, () => {
        const call = calls.find((c) => c.opts.names.includes(toolName));
        expect(call).toBeDefined();
        const def = call!.def;
        expect(def.name).toBe(toolName);
        expect(typeof def.description).toBe("string");
        expect(def.description!.length).toBeGreaterThan(5);
        expect(typeof def.label).toBe("string");
        expect(def.label!.length).toBeGreaterThan(0);
        expect(def.parameters).toBeDefined();
        expect(typeof def.parameters).toBe("object");
      });
    }
  });

  describe("Fund tools (9)", () => {
    let calls: RegisterToolCall[];

    beforeEach(() => {
      const { api, calls: c } = createCaptureMockApi();
      calls = c;
      const manager = new FundManager(join(tmpDir, "fund.json"), {
        totalCapital: 100000,
        cashReservePct: 30,
        maxSingleStrategyPct: 30,
        maxTotalExposurePct: 70,
        rebalanceFrequency: "weekly" as const,
      });
      const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
      const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
      registerFundTools(api as never, {
        manager,
        config: {
          totalCapital: 100000,
          cashReservePct: 30,
          maxSingleStrategyPct: 30,
          maxTotalExposurePct: 70,
          rebalanceFrequency: "weekly" as const,
        },
        flowStore,
        perfStore,
        getRegistry: () => undefined,
        getPaper: () => undefined,
      });
    });

    it("registers exactly 9 fund tools", () => {
      const names = calls.flatMap((c) => c.opts.names);
      expect(names).toEqual(expect.arrayContaining(FUND_TOOLS));
      expect(names).toHaveLength(9);
    });

    for (const toolName of FUND_TOOLS) {
      it(`${toolName}: has name, description, label, and parameters`, () => {
        const call = calls.find((c) => c.opts.names.includes(toolName));
        expect(call).toBeDefined();
        const def = call!.def;
        expect(def.name).toBe(toolName);
        expect(typeof def.description).toBe("string");
        expect(def.description!.length).toBeGreaterThan(5);
        expect(typeof def.label).toBe("string");
        expect(def.label!.length).toBeGreaterThan(0);
        expect(def.parameters).toBeDefined();
        expect(typeof def.parameters).toBe("object");
      });
    }
  });

  describe("Execution tools (5)", () => {
    let calls: RegisterToolCall[];

    beforeEach(() => {
      const { api, calls: c } = createCaptureMockApi();
      calls = c;
      const registry = new ExchangeRegistry();
      const riskController = new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      });
      registerTradingTools(api as never, registry, riskController);
    });

    it("registers exactly 5 execution tools", () => {
      const names = calls.flatMap((c) => c.opts.names);
      expect(names).toEqual(expect.arrayContaining(EXECUTION_TOOLS));
      expect(names).toHaveLength(5);
    });

    for (const toolName of EXECUTION_TOOLS) {
      it(`${toolName}: has name, description, label, and parameters`, () => {
        const call = calls.find((c) => c.opts.names.includes(toolName));
        expect(call).toBeDefined();
        const def = call!.def;
        expect(def.name).toBe(toolName);
        expect(typeof def.description).toBe("string");
        expect(def.description!.length).toBeGreaterThan(5);
        expect(typeof def.label).toBe("string");
        expect(def.label!.length).toBeGreaterThan(0);
        expect(def.parameters).toBeDefined();
        expect(typeof def.parameters).toBe("object");
      });
    }
  });

  describe("Full catalog (25 tools)", () => {
    it("all 4 register* functions combined produce exactly 25 unique tools", () => {
      const { api: api1, calls: c1 } = createCaptureMockApi();
      const { api: api2, calls: c2 } = createCaptureMockApi();
      const { api: api3, calls: c3 } = createCaptureMockApi();
      const { api: api4, calls: c4 } = createCaptureMockApi();

      const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
      const bridge = new RemoteBacktestBridge(() => undefined);
      registerStrategyTools(api1 as never, registry, bridge, null, null);

      const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
      const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
      registerPaperTools(api2 as never, paperEngine);

      const manager = new FundManager(join(tmpDir, "fund.json"), {
        totalCapital: 100000,
        cashReservePct: 30,
        maxSingleStrategyPct: 30,
        maxTotalExposurePct: 70,
        rebalanceFrequency: "weekly" as const,
      });
      const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
      const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
      registerFundTools(api3 as never, {
        manager,
        config: {
          totalCapital: 100000,
          cashReservePct: 30,
          maxSingleStrategyPct: 30,
          maxTotalExposurePct: 70,
          rebalanceFrequency: "weekly" as const,
        },
        flowStore,
        perfStore,
        getRegistry: () => undefined,
        getPaper: () => undefined,
      });

      const exchRegistry = new ExchangeRegistry();
      const riskController = new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      });
      registerTradingTools(api4 as never, exchRegistry, riskController);

      const allCalls = [...c1, ...c2, ...c3, ...c4];
      const allNames = allCalls.flatMap((c) => c.opts.names);
      const uniqueNames = new Set(allNames);

      expect(uniqueNames.size).toBe(25);
      for (const expected of ALL_TOOLS) {
        expect(uniqueNames.has(expected)).toBe(true);
      }
    });

    it("no tool has duplicate registration names", () => {
      const { api: api1, calls: c1 } = createCaptureMockApi();
      const { api: api2, calls: c2 } = createCaptureMockApi();
      const { api: api3, calls: c3 } = createCaptureMockApi();
      const { api: api4, calls: c4 } = createCaptureMockApi();

      const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
      const bridge = new RemoteBacktestBridge(() => undefined);
      registerStrategyTools(api1 as never, registry, bridge, null, null);

      const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
      const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
      registerPaperTools(api2 as never, paperEngine);

      const manager = new FundManager(join(tmpDir, "fund.json"), {
        totalCapital: 100000,
        cashReservePct: 30,
        maxSingleStrategyPct: 30,
        maxTotalExposurePct: 70,
        rebalanceFrequency: "weekly" as const,
      });
      const flowStore = new CapitalFlowStore(join(tmpDir, "flows.sqlite"));
      const perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.sqlite"));
      registerFundTools(api3 as never, {
        manager,
        config: {
          totalCapital: 100000,
          cashReservePct: 30,
          maxSingleStrategyPct: 30,
          maxTotalExposurePct: 70,
          rebalanceFrequency: "weekly" as const,
        },
        flowStore,
        perfStore,
        getRegistry: () => undefined,
        getPaper: () => undefined,
      });

      const exchRegistry = new ExchangeRegistry();
      const riskController = new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      });
      registerTradingTools(api4 as never, exchRegistry, riskController);

      const allNames = [...c1, ...c2, ...c3, ...c4].flatMap((c) => c.opts.names);
      const seen = new Set<string>();
      for (const name of allNames) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    });
  });
});
