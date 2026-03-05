import { describe, it, expect, vi } from "vitest";
import { IdeationEngine } from "../../src/ideation/ideation-engine.js";
import type { MarketSnapshot, SymbolSnapshot } from "../../src/ideation/types.js";

function makeSnapshot(symbols: SymbolSnapshot[]): MarketSnapshot {
  return {
    timestamp: Date.now(),
    symbols,
    regimeSummary: { bull: symbols.filter((s) => s.regime === "bull").map((s) => s.symbol) },
    crossMarket: {
      cryptoBullishPct: 60,
      equityBullishPct: 50,
      highVolatilitySymbols: [],
    },
  };
}

function makeSymbol(overrides: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  return {
    symbol: "BTC/USDT",
    market: "crypto",
    regime: "bull",
    price: 65000,
    change24hPct: 2.5,
    indicators: {
      rsi14: 55,
      sma50: 64000,
      sma200: 60000,
      macdHistogram: 150,
      bbPosition: 0.65,
      atr14Pct: 2.1,
    },
    ...overrides,
  };
}

describe("IdeationEngine", () => {
  it("builds prompt with symbol table and templates", () => {
    const engine = new IdeationEngine({});
    const snapshot = makeSnapshot([
      makeSymbol({ symbol: "BTC/USDT", regime: "bull" }),
      makeSymbol({ symbol: "ETH/USDT", regime: "sideways" }),
    ]);

    const prompt = engine.buildPrompt(snapshot, [], 3);

    expect(prompt).toContain("Strategy Ideation");
    expect(prompt).toContain("BTC/USDT");
    expect(prompt).toContain("ETH/USDT");
    expect(prompt).toContain("sma-crossover");
    expect(prompt).toContain("rsi-mean-reversion");
    expect(prompt).toContain("fin_strategy_create");
    expect(prompt).toContain("up to 3 new strategy hypotheses");
  });

  it("includes existing strategies in prompt to prevent duplication", () => {
    const engine = new IdeationEngine({});
    const snapshot = makeSnapshot([makeSymbol()]);
    const existing = ["SMA Cross BTC (BTC/USDT)", "RSI Mean ETH (ETH/USDT)"];

    const prompt = engine.buildPrompt(snapshot, existing, 3);

    expect(prompt).toContain("Existing Strategies (DO NOT duplicate)");
    expect(prompt).toContain("SMA Cross BTC (BTC/USDT)");
    expect(prompt).toContain("RSI Mean ETH (ETH/USDT)");
  });

  it("includes regime-to-strategy matching guidance", () => {
    const engine = new IdeationEngine({});
    const snapshot = makeSnapshot([makeSymbol()]);

    const prompt = engine.buildPrompt(snapshot, [], 3);

    expect(prompt).toContain("Bull/bear regimes");
    expect(prompt).toContain("Sideways regime");
    expect(prompt).toContain("Volatile regime");
    expect(prompt).toContain("Crisis regime");
  });

  it("triggerIdeation wakes LLM via bridge", () => {
    const onIdeationScanComplete = vi.fn();
    const appendLog = vi.fn();
    const engine = new IdeationEngine({
      wakeBridge: { onIdeationScanComplete } as never,
      activityLog: { append: appendLog } as never,
    });

    const snapshot = makeSnapshot([makeSymbol()]);
    engine.triggerIdeation(snapshot, [], 3);

    expect(onIdeationScanComplete).toHaveBeenCalledOnce();
    const call = onIdeationScanComplete.mock.calls[0]![0];
    expect(call.symbolCount).toBe(1);
    expect(call.prompt).toContain("BTC/USDT");

    expect(appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ category: "ideation", action: "ideation_wake" }),
    );
  });

  it("triggerIdeation skips when snapshot is empty", () => {
    const onIdeationScanComplete = vi.fn();
    const appendLog = vi.fn();
    const engine = new IdeationEngine({
      wakeBridge: { onIdeationScanComplete } as never,
      activityLog: { append: appendLog } as never,
    });

    const snapshot = makeSnapshot([]);
    engine.triggerIdeation(snapshot, [], 3);

    expect(onIdeationScanComplete).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ideation_skipped" }));
  });

  it("includes cross-market overview in prompt", () => {
    const engine = new IdeationEngine({});
    const snapshot: MarketSnapshot = {
      timestamp: Date.now(),
      symbols: [makeSymbol()],
      regimeSummary: { bull: ["BTC/USDT"] },
      crossMarket: {
        cryptoBullishPct: 70,
        equityBullishPct: 40,
        highVolatilitySymbols: ["DOGE/USDT"],
      },
    };

    const prompt = engine.buildPrompt(snapshot, [], 3);

    expect(prompt).toContain("Crypto bullish: 70%");
    expect(prompt).toContain("Equity bullish: 40%");
    expect(prompt).toContain("High volatility: DOGE/USDT");
  });
});
