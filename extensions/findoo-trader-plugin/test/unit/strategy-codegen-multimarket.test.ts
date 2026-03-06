/**
 * L1 Unit Test: strategy-codegen multi-market support.
 *
 * Verifies that generateStrategyZip produces correct fep.yaml with
 * dataSource=datahub and classification.market for each market type.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generateStrategyZip, resolveRemoteMarket } from "../../src/strategy/strategy-codegen.js";
import type { StrategyDefinition } from "../../src/strategy/types.js";

function makeDef(overrides: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    id: "sma-crossover-test123",
    name: "Test SMA",
    version: "1.0.0",
    description: "test",
    parameters: { fastPeriod: 10, slowPeriod: 30 },
    symbols: ["BTC-USD"],
    timeframes: ["1d"],
    markets: ["crypto"],
    ...overrides,
  } as StrategyDefinition;
}

async function extractFepYaml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files);
  const fepFile = files.find((f) => f.endsWith("fep.yaml"));
  expect(fepFile).toBeDefined();
  return await zip.files[fepFile!].async("text");
}

describe("resolveRemoteMarket", () => {
  it("maps crypto → Crypto", () => {
    expect(resolveRemoteMarket("crypto", "BTC-USD")).toBe("Crypto");
  });

  it("maps equity + US symbol → US", () => {
    expect(resolveRemoteMarket("equity", "AAPL")).toBe("US");
    expect(resolveRemoteMarket("equity", "TSLA")).toBe("US");
  });

  it("maps equity + CN symbol → CN", () => {
    expect(resolveRemoteMarket("equity", "600519.SH")).toBe("CN");
    expect(resolveRemoteMarket("equity", "000001.SZ")).toBe("CN");
  });

  it("maps equity + HK symbol → HK", () => {
    expect(resolveRemoteMarket("equity", "00700.HK")).toBe("HK");
    expect(resolveRemoteMarket("equity", "09988.HK")).toBe("HK");
  });

  it("maps forex → Forex", () => {
    expect(resolveRemoteMarket("forex", "EUR/USD")).toBe("Forex");
  });

  it("maps commodity → Commodity", () => {
    expect(resolveRemoteMarket("commodity", "GLD")).toBe("Commodity");
  });

  it("passes through already-correct values", () => {
    expect(resolveRemoteMarket("US", "AAPL")).toBe("US");
    expect(resolveRemoteMarket("CN", "600519.SH")).toBe("CN");
    expect(resolveRemoteMarket("HK", "00700.HK")).toBe("HK");
  });

  it("maps direct market labels (cn, hk)", () => {
    expect(resolveRemoteMarket("cn", "600519.SH")).toBe("CN");
    expect(resolveRemoteMarket("hk", "00700.HK")).toBe("HK");
  });
});

describe("generateStrategyZip — multi-market fep.yaml", () => {
  it("generates datahub + Crypto for BTC-USD", async () => {
    const def = makeDef({ symbols: ["BTC-USD"], markets: ["crypto"] });
    const { buffer } = await generateStrategyZip(def);
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("dataSource: datahub");
    expect(yaml).toContain("market: Crypto");
    expect(yaml).toContain("symbols: [BTC-USD]");
  });

  it("generates datahub + US for AAPL", async () => {
    const def = makeDef({
      id: "sma-crossover-us01",
      symbols: ["AAPL"],
      markets: ["equity"],
    });
    const { buffer } = await generateStrategyZip(def);
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("dataSource: datahub");
    expect(yaml).toContain("market: US");
    expect(yaml).toContain("symbols: [AAPL]");
  });

  it("generates datahub + CN for 600519.SH", async () => {
    const def = makeDef({
      id: "rsi-mean-reversion-cn01",
      symbols: ["600519.SH"],
      markets: ["equity"],
    });
    const { buffer } = await generateStrategyZip(def);
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("dataSource: datahub");
    expect(yaml).toContain("market: CN");
    expect(yaml).toContain("symbols: [600519.SH]");
  });

  it("generates datahub + HK for 00700.HK", async () => {
    const def = makeDef({
      id: "bollinger-bands-hk01",
      symbols: ["00700.HK"],
      markets: ["equity"],
    });
    const { buffer } = await generateStrategyZip(def);
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("dataSource: datahub");
    expect(yaml).toContain("market: HK");
    expect(yaml).toContain("symbols: [00700.HK]");
  });

  it("respects explicit market override via options", async () => {
    const def = makeDef({ symbols: ["TSLA"], markets: ["equity"] });
    const { buffer } = await generateStrategyZip(def, {
      market: "US",
      dataSource: "synthetic",
    });
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("dataSource: synthetic");
    expect(yaml).toContain("market: US");
  });

  it("includes start_date and end_date when provided", async () => {
    const def = makeDef({ symbols: ["AAPL"], markets: ["equity"] });
    const { buffer } = await generateStrategyZip(def, {
      startDate: "2025-01-01",
      endDate: "2026-01-01",
    });
    const yaml = await extractFepYaml(buffer);

    expect(yaml).toContain("start_date: 2025-01-01");
    expect(yaml).toContain("end_date: 2026-01-01");
  });

  it("generates valid Python strategy.py for each market", async () => {
    const markets = [
      { id: "sma-crossover-us01", symbol: "AAPL", market: "equity" },
      { id: "rsi-mean-reversion-cn01", symbol: "600519.SH", market: "equity" },
      { id: "bollinger-bands-hk01", symbol: "00700.HK", market: "equity" },
      { id: "macd-divergence-btc01", symbol: "BTC-USD", market: "crypto" },
    ];

    for (const m of markets) {
      const def = makeDef({ id: m.id, symbols: [m.symbol], markets: [m.market] });
      const { buffer } = await generateStrategyZip(def);

      const zip = await JSZip.loadAsync(buffer);
      const pyFile = Object.keys(zip.files).find((f) => f.endsWith("strategy.py"));
      expect(pyFile, `Python file missing for ${m.symbol}`).toBeDefined();

      const pyContent = await zip.files[pyFile!].async("text");
      expect(pyContent).toContain("def compute(data):");
      expect(pyContent).toContain("import pandas as pd");
    }
  });
});
