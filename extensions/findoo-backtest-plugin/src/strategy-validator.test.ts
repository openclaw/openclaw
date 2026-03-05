import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateStrategy } from "./strategy-validator.js";

const VALID_FEP_YAML = `
# Section A — Identity
section_a:
  name: TestStrategy
  version: "1.0"
  author: test

# Section B — Classification
section_b:
  asset_class: crypto
  timeframe: 1d
  strategy_type: momentum
  symbols: [BTC-USD]
`;

const VALID_STRATEGY_PY = `
from base import StrategyBase

class TestStrategy(StrategyBase):
    def __init__(self):
        self.symbol = "BTC-USD"

    def execute(self, data, portfolio):
        if data.rsi < 30:
            portfolio.buy(self.symbol, 0.1)
        elif data.rsi > 70:
            portfolio.sell(self.symbol, 0.1)

    def record_trade(self, trade_info):
        self.trades.append(trade_info)
`;

describe("validateStrategy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "strat-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a fully valid strategy directory. */
  async function createValidStrategy(dir?: string) {
    const d = dir ?? tmpDir;
    const scriptsDir = join(d, "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(d, "fep.yaml"), VALID_FEP_YAML);
    await writeFile(join(scriptsDir, "strategy.py"), VALID_STRATEGY_PY);
    await writeFile(join(scriptsDir, "requirements.txt"), "pandas>=2.0\n");
    await writeFile(join(scriptsDir, "risk_manager.py"), "class RiskManager:\n  pass\n");
  }

  // -- Happy path --

  it("passes for a fully valid strategy directory", async () => {
    await createValidStrategy();
    const result = await validateStrategy(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -- Non-existent / not-a-directory --

  it("fails when directory does not exist", async () => {
    const result = await validateStrategy("/nonexistent/path/xyz");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("not found");
  });

  it("fails when path is a file, not a directory", async () => {
    const filePath = join(tmpDir, "notadir.txt");
    await writeFile(filePath, "hello");
    const result = await validateStrategy(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("not a directory");
  });

  // -- Structure checks --

  it("error when fep.yaml missing", async () => {
    await mkdir(join(tmpDir, "scripts"), { recursive: true });
    await writeFile(join(tmpDir, "scripts", "strategy.py"), VALID_STRATEGY_PY);
    const result = await validateStrategy(tmpDir);
    expect(result.errors.some((e) => e.category === "structure" && e.file === "fep.yaml")).toBe(
      true,
    );
  });

  it("error when scripts/strategy.py missing", async () => {
    await writeFile(join(tmpDir, "fep.yaml"), VALID_FEP_YAML);
    const result = await validateStrategy(tmpDir);
    expect(result.errors.some((e) => e.file === "scripts/strategy.py")).toBe(true);
  });

  it("warning when requirements.txt missing", async () => {
    await createValidStrategy();
    await rm(join(tmpDir, "scripts", "requirements.txt"));
    const result = await validateStrategy(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.file === "scripts/requirements.txt")).toBe(true);
  });

  it("warning when risk_manager.py missing", async () => {
    await createValidStrategy();
    await rm(join(tmpDir, "scripts", "risk_manager.py"));
    const result = await validateStrategy(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.file === "scripts/risk_manager.py")).toBe(true);
  });

  // -- Interface checks --

  it("error when strategy.py has no Strategy class", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
def execute(self, data, portfolio):
    pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "interface" && e.message.includes("Strategy")),
    ).toBe(true);
  });

  it("error when strategy.py has no execute method", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
class MomentumStrategy:
    def record_trade(self, info):
        pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "interface" && e.message.includes("execute")),
    ).toBe(true);
  });

  it("warning when strategy.py has no record_trade method", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
class MomentumStrategy:
    def execute(self, data, portfolio):
        pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.warnings.some((w) => w.category === "interface" && w.message.includes("record_trade")),
    ).toBe(true);
  });

  // -- Safety checks --

  it("error for dangerous imports (os, subprocess, eval, exec)", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
import subprocess
class TestStrategy:
    def execute(self, data, portfolio):
        subprocess.run(["ls"])
    def record_trade(self, info):
        pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "safety" && e.message.includes("subprocess")),
    ).toBe(true);
  });

  it("error for eval/exec calls", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "helper.py"),
      `
result = eval("1+1")
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(result.errors.some((e) => e.category === "safety" && e.message.includes("eval"))).toBe(
      true,
    );
  });

  it("warning for network imports (requests, httpx)", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
import requests
class TestStrategy:
    def execute(self, data, portfolio):
        pass
    def record_trade(self, info):
        pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.warnings.some((w) => w.category === "safety" && w.message.includes("requests")),
    ).toBe(true);
  });

  // -- YAML checks --

  it("error when fep.yaml missing Section A", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
section_b:
  asset_class: crypto
  timeframe: 1d
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "yaml" && e.message.includes("Section A")),
    ).toBe(true);
  });

  it("error when fep.yaml missing Section B", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
section_a:
  name: Test
  version: "1.0"
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "yaml" && e.message.includes("Section B")),
    ).toBe(true);
  });

  it("accepts heading-style sections (# Section A)", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
# Section A
name: Test
version: "1.0"

# Section B
asset_class: crypto
symbols: [BTC-USD]
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(result.errors.filter((e) => e.category === "yaml")).toHaveLength(0);
  });

  // -- YAML v1.1 identity.id check --

  it("error when v1.1 identity: section missing id field", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
identity:
  name: test-strategy
  version: "1.0"
  author: test
technical:
  asset_class: crypto
  timeframe: 1d
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.errors.some((e) => e.category === "yaml" && e.message.includes("identity.id")),
    ).toBe(true);
  });

  it("passes when v1.1 identity: section has id field", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
identity:
  id: my-strategy
  name: test-strategy
  version: "1.0"
  author: test
technical:
  asset_class: crypto
  timeframe: 1d
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(result.errors.filter((e) => e.message.includes("identity.id"))).toHaveLength(0);
  });

  it("no identity.id error for v1.0 section_a format", async () => {
    await createValidStrategy();
    // section_a format (v1.0) does not require identity.id
    const result = await validateStrategy(tmpDir);
    expect(result.errors.filter((e) => e.message.includes("identity.id"))).toHaveLength(0);
  });

  // -- Data checks --

  it("warning when fep.yaml symbol not referenced in strategy.py", async () => {
    await createValidStrategy();
    await writeFile(
      join(tmpDir, "fep.yaml"),
      `
section_a:
  name: Test
  version: "1.0"
section_b:
  asset_class: crypto
  symbols: [ETH-USD, SOL-USD]
`,
    );
    await writeFile(
      join(tmpDir, "scripts", "strategy.py"),
      `
class TestStrategy:
    symbol = "BTC-USD"
    def execute(self, data, portfolio):
        pass
    def record_trade(self, info):
        pass
`,
    );
    const result = await validateStrategy(tmpDir);
    expect(
      result.warnings.some((w) => w.category === "data" && w.message.includes("ETH-USD")),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.category === "data" && w.message.includes("SOL-USD")),
    ).toBe(true);
  });
});
