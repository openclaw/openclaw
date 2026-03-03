import { describe, expect, it, vi } from "vitest";
import { registerPaperTools } from "./paper-tools.js";
import { registerStrategyTools } from "./strategy-tools.js";

// ── Helpers ──

function createToolCapture() {
  const tools = new Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >();
  const services = new Map<string, unknown>();
  const api = {
    runtime: { services },
    registerTool: vi.fn((def: Record<string, unknown>, _opts: unknown) => {
      tools.set(def.name as string, {
        execute: def.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>,
      });
    }),
  };
  return { api, tools, services };
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

// ── Paper Tools ──

describe("paper-tools", () => {
  it("registers 3 paper tools", () => {
    const { api } = createToolCapture();
    registerPaperTools(api as never);
    expect(api.registerTool).toHaveBeenCalledTimes(3);
  });

  // ── fin_paper_create ──

  describe("fin_paper_create", () => {
    it("returns error when paper engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_create")!.execute;
      const result = parseResult(await exec("c1", { name: "test", capital: 10000 }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Paper trading engine not available");
    });

    it("creates account when paper engine is available", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-paper-engine", {
        createAccount: vi.fn((_name: string, _capital: number) => ({
          id: "paper-001",
          name: "test",
          equity: 10000,
        })),
        submitOrder: vi.fn(),
        getAccountState: vi.fn(),
        listAccounts: vi.fn(),
      });
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_create")!.execute;
      const result = parseResult(await exec("c2", { name: "test", capital: 10000 }));

      expect(result.success).toBe(true);
      expect(result.message).toContain("test");
      expect(result.message).toContain("10000");
      expect(result.account).toMatchObject({ id: "paper-001" });
    });

    it("returns error when createAccount throws", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-paper-engine", {
        createAccount: vi.fn(() => {
          throw new Error("Duplicate name");
        }),
        submitOrder: vi.fn(),
        getAccountState: vi.fn(),
        listAccounts: vi.fn(),
      });
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_create")!.execute;
      const result = parseResult(await exec("c3", { name: "test", capital: 10000 }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Duplicate name");
    });
  });

  // ── fin_paper_order ──

  describe("fin_paper_order", () => {
    it("returns error when paper engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_order")!.execute;
      const result = parseResult(
        await exec("c4", { accountId: "p1", symbol: "BTC/USDT", side: "buy", qty: 0.1 }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Paper trading engine not available");
    });

    it("submits order when engine is available", async () => {
      const { api, tools, services } = createToolCapture();
      const submitOrder = vi.fn(() => ({
        orderId: "pord-1",
        symbol: "BTC/USDT",
        side: "buy",
        filled: 0.1,
      }));
      services.set("fin-paper-engine", {
        createAccount: vi.fn(),
        submitOrder,
        getAccountState: vi.fn(),
        listAccounts: vi.fn(),
      });
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_order")!.execute;
      const result = parseResult(
        await exec("c5", { accountId: "p1", symbol: "BTC/USDT", side: "buy", qty: 0.1 }),
      );

      expect(result.success).toBe(true);
      expect(submitOrder).toHaveBeenCalledWith("p1", {
        symbol: "BTC/USDT",
        side: "buy",
        qty: 0.1,
        type: "market",
        price: undefined,
      });
    });
  });

  // ── fin_paper_state ──

  describe("fin_paper_state", () => {
    it("returns error when paper engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_state")!.execute;
      const result = parseResult(await exec("c6", {}));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Paper trading engine not available");
    });

    it("returns specific account when accountId provided", async () => {
      const { api, tools, services } = createToolCapture();
      const mockState = { id: "p1", name: "demo", equity: 9500, positions: [] };
      services.set("fin-paper-engine", {
        createAccount: vi.fn(),
        submitOrder: vi.fn(),
        getAccountState: vi.fn(() => mockState),
        listAccounts: vi.fn(),
      });
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_state")!.execute;
      const result = parseResult(await exec("c7", { accountId: "p1" }));

      expect(result.success).toBe(true);
      expect(result.account).toMatchObject({ id: "p1", equity: 9500 });
    });

    it("lists all accounts when no accountId provided", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-paper-engine", {
        createAccount: vi.fn(),
        submitOrder: vi.fn(),
        getAccountState: vi.fn(),
        listAccounts: vi.fn(() => [
          { id: "p1", name: "demo1" },
          { id: "p2", name: "demo2" },
        ]),
      });
      registerPaperTools(api as never);

      const exec = tools.get("fin_paper_state")!.execute;
      const result = parseResult(await exec("c8", {}));

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(2);
    });
  });
});

// ── Strategy Tools ──

describe("strategy-tools", () => {
  it("registers 3 strategy tools", () => {
    const { api } = createToolCapture();
    registerStrategyTools(api as never);
    expect(api.registerTool).toHaveBeenCalledTimes(3);
  });

  // ── fin_strategy_create ──

  describe("fin_strategy_create", () => {
    it("returns error when strategy engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerStrategyTools(api as never);

      const exec = tools.get("fin_strategy_create")!.execute;
      const result = parseResult(
        await exec("s1", { name: "SMA Cross", symbol: "BTC/USDT" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Strategy engine not available");
    });

    it("creates strategy when registry is available", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn((def: Record<string, unknown>) => ({ id: "strat-1", ...def })),
        list: vi.fn(),
        get: vi.fn(),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_strategy_create")!.execute;
      const result = parseResult(
        await exec("s2", {
          name: "SMA Cross",
          symbol: "BTC/USDT",
          timeframe: "4h",
          parameters: '{"fast": 10, "slow": 30}',
        }),
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("SMA Cross");
      expect((result.strategy as Record<string, unknown>).level).toBe("L0_INCUBATE");
    });

    it("returns error for invalid JSON in parameters field", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_strategy_create")!.execute;
      const result = parseResult(
        await exec("s3", { name: "Bad", symbol: "BTC/USDT", parameters: "not-json{" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid JSON");
    });
  });

  // ── fin_strategy_list ──

  describe("fin_strategy_list", () => {
    it("returns error when strategy engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerStrategyTools(api as never);

      const exec = tools.get("fin_strategy_list")!.execute;
      const result = parseResult(await exec("s4", {}));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Strategy engine not available");
    });

    it("lists strategies when registry is available", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn(),
        list: vi.fn(() => [
          { id: "s1", name: "SMA", level: "L1_BACKTEST" },
          { id: "s2", name: "RSI", level: "L0_INCUBATE" },
        ]),
        get: vi.fn(),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_strategy_list")!.execute;
      const result = parseResult(await exec("s5", {}));

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.strategies).toHaveLength(2);
    });
  });

  // ── fin_backtest_run ──

  describe("fin_backtest_run", () => {
    it("returns error when strategy engine not available", async () => {
      const { api, tools } = createToolCapture();
      registerStrategyTools(api as never);

      const exec = tools.get("fin_backtest_run")!.execute;
      const result = parseResult(await exec("b1", { strategyId: "s1" }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Strategy engine not available");
    });

    it("returns error when backtest engine not available", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(() => ({ id: "s1" })),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_backtest_run")!.execute;
      const result = parseResult(await exec("b2", { strategyId: "s1" }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backtest engine not available");
    });

    it("returns error when strategy not found", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(() => undefined),
      });
      services.set("fin-backtest-engine", {
        run: vi.fn(),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_backtest_run")!.execute;
      const result = parseResult(await exec("b3", { strategyId: "nonexistent" }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("runs backtest and returns results", async () => {
      const { api, tools, services } = createToolCapture();
      services.set("fin-strategy-registry", {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(() => ({ id: "s1", name: "SMA Cross" })),
      });
      services.set("fin-backtest-engine", {
        run: vi.fn(async () => ({
          totalReturn: 0.25,
          sharpe: 1.5,
          maxDrawdown: 0.12,
          winRate: 0.58,
        })),
      });
      registerStrategyTools(api as never);

      const exec = tools.get("fin_backtest_run")!.execute;
      const result = parseResult(
        await exec("b4", { strategyId: "s1", symbol: "BTC/USDT", initialCapital: 50000 }),
      );

      expect(result.success).toBe(true);
      expect(result.strategyId).toBe("s1");
      expect((result.result as Record<string, unknown>).sharpe).toBe(1.5);
    });
  });
});
