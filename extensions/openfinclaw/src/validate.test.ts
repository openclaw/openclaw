/**
 * Tests for strategy package validation (FEP v2.0).
 * Uses real node:fs/promises for file operations.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateStrategyPackage } from "./validate.js";

describe("validateStrategyPackage (FEP v2.0)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "fep-v2-validate-"));
  });

  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  /**
   * 创建最小有效策略包
   */
  function createMinimalValidPackage(): string {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: fin-test-minimal
  name: "Test Strategy"
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "A test strategy"
  description: "A simple test strategy for validation"
  license: MIT
  tags: [test, validation]
  author:
    name: "Test Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial release"
technical:
  language: python
  entryPoint: strategy.py
backtest:
  symbol: "BTC/USDT"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import numpy as np

def compute(data, context=None):
    close = data["close"].values
    price = float(close[-1])
    return {"action": "hold", "amount": 0, "price": price, "reason": "test"}
`,
    );

    return tmpDir;
  }

  // ── 基础验证测试 ──

  it("returns valid for minimal FEP v2.0 package", async () => {
    const dir = createMinimalValidPackage();
    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns invalid when fep.yaml is missing", async () => {
    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fep.yaml"))).toBe(true);
  });

  it("returns invalid when scripts/strategy.py is missing", async () => {
    writeFileSync(path.join(tmpDir, "fep.yaml"), `fep: "2.0"\nidentity:\n  id: test\n  name: Test`);

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("strategy.py"))).toBe(true);
  });

  // ── 版本验证测试 ──

  it("rejects fep version other than 2.0", async () => {
    writeFileSync(path.join(tmpDir, "fep.yaml"), `fep: "1.2"\nidentity:\n  id: test\n  name: Test`);

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("版本必须为") && e.includes("2.0"))).toBe(true);
  });

  // ── identity 必填字段测试 ──

  it("requires identity.id", async () => {
    writeFileSync(path.join(tmpDir, "fep.yaml"), `fep: "2.0"\nidentity:\n  name: Test`);

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("identity") && e.includes("id"))).toBe(true);
  });

  it("requires identity.name", async () => {
    writeFileSync(path.join(tmpDir, "fep.yaml"), `fep: "2.0"\nidentity:\n  id: test`);

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("identity") && e.includes("name"))).toBe(true);
  });

  it("requires identity.author.name", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    wallet: "0x..."
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("author") && e.includes("name"))).toBe(true);
  });

  // ── style 枚举验证测试 ──

  it("validates style enum values", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: invalid_style
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("style"))).toBe(true);
  });

  // ── backtest 验证测试 ──

  it("requires backtest.symbol", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("symbol"))).toBe(true);
  });

  it("requires backtest.initialCapital", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("initialCapital"))).toBe(true);
  });

  // ── symbol 格式验证测试 ──

  it("recognizes Crypto symbol format (BTC/USDT)", async () => {
    const dir = createMinimalValidPackage();
    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
  });

  it("recognizes A-share symbol format (000001.SZ)", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "000001.SZ"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 100000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
  });

  it("recognizes US stock symbol format (AAPL)", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "AAPL"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
  });

  it("recognizes HK stock symbol format (00700.HK)", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "00700.HK"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
  });

  // ── 策略函数验证测试 ──

  it("accepts compute(data) function", async () => {
    const dir = createMinimalValidPackage();
    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
  });

  it("accepts compute(data, context=None) function", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
def compute(data, context=None):
    position = context.get("position") if context else None
    return {"action": "hold", "amount": 0, "price": 0, "reason": "test"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
  });

  it("accepts select(universe) function for multi-asset strategies", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test-rotation
  name: "Rotation Strategy"
  type: strategy
  version: "1.0.0"
  style: rotation
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "000001.SZ"
  universe:
    symbols:
      - "000001.SZ"
      - "000002.SZ"
      - "600519.SH"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 1000000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import numpy as np

def select(universe):
    scores = []
    for symbol, df in universe.items():
        close = df["close"].values
        if len(close) >= 20:
            momentum = (close[-1] / close[-20]) - 1
            scores.append((symbol, momentum))
    scores.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scores]
`,
    );

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
  });

  it("rejects strategy without compute or select function", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
# No compute or select function
def helper():
    pass
`,
    );

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("compute") || e.includes("select"))).toBe(true);
  });

  // ── 安全沙箱测试 ──

  it("rejects forbidden import os", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import os

def compute(data):
    return {"action": "hold"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("禁止的导入") && e.includes("os"))).toBe(true);
  });

  it("rejects forbidden eval() call", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
def compute(data):
    result = eval("1 + 1")
    return {"action": "hold"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("禁止的函数调用") && e.includes("eval"))).toBe(
      true,
    );
  });

  it("rejects datetime.now() that breaks backtest consistency", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import datetime

def compute(data):
    now = datetime.datetime.now()
    return {"action": "hold"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("datetime.now") && e.includes("回测一致性"))).toBe(
      true,
    );
  });

  it("ignores datetime.now() in comments", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
# Note: do not use datetime.now() in production
def compute(data):
    return {"action": "hold"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
  });

  it("rejects forbidden requests import", async () => {
    const dir = createMinimalValidPackage();

    const scriptDir = path.join(tmpDir, "scripts");
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import requests

def compute(data):
    return {"action": "hold"}
`,
    );

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requests"))).toBe(true);
  });

  // ── timeframe 验证测试 ──

  it("validates timeframe enum values", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  timeframe: 1h
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid timeframe value", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: test
  name: Test
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: private
  summary: "test"
  description: "test"
  license: MIT
  tags: [test]
  author:
    name: "Author"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial"
backtest:
  symbol: "BTC/USDT"
  timeframe: 2h
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("timeframe"))).toBe(true);
  });

  // ── 完整配置测试 ──

  it("accepts full configuration with all optional fields", async () => {
    writeFileSync(
      path.join(tmpDir, "fep.yaml"),
      `
fep: "2.0"
identity:
  id: fin-full-test
  name: "Full Test Strategy"
  type: strategy
  version: "1.0.0"
  style: hybrid
  visibility: public
  summary: "A comprehensive test strategy"
  description: "Full configuration test with all optional fields"
  license: MIT
  tags: [test, full, hybrid]
  author:
    name: "Test Author"
    wallet: "0x1234567890abcdef"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial release"
technical:
  language: python
  entryPoint: strategy.py
parameters:
  - name: fast_period
    default: 12
    type: integer
    label: "快速周期"
    range: { min: 5, max: 50 }
  - name: slow_period
    default: 26
    type: integer
    label: "慢速周期"
backtest:
  symbol: "BTC/USDT"
  timeframe: 4h
  defaultPeriod:
    startDate: "2023-01-01"
    endDate: "2024-12-31"
  initialCapital: 50000
risk:
  maxDrawdownThreshold: 20
  dailyLossLimitPct: 5
  maxTradesPerDay: 10
paper:
  barIntervalSeconds: 60
  maxDurationHours: 24
  warmupBars: 100
  timeframe: 1h
classification:
  archetype: systematic
  market: Crypto
  assetClasses: [crypto]
  frequency: daily
  riskProfile: medium
`,
    );

    const scriptDir = path.join(tmpDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import numpy as np
import pandas as pd

def compute(data, context=None):
    close = data["close"].values
    price = float(close[-1])
    ma20 = float(np.mean(close[-20:])) if len(close) >= 20 else price

    has_position = context and context.get("position") is not None

    if not has_position and price > ma20:
        return {"action": "buy", "amount": 1000, "price": price, "reason": "Price above MA20"}
    elif has_position and price < ma20:
        return {"action": "sell", "reason": "Price below MA20"}

    return {"action": "hold", "reason": f"MA20={ma20:.2f}"}
`,
    );

    const result = await validateStrategyPackage(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
