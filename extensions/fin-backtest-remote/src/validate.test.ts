/**
 * Tests for strategy package validation (real fs; no fetch).
 * When run alone, uses real node:fs/promises. When run with index.test.ts (which mocks fs/promises), skips the two tests that need real file reads.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateStrategyPackage } from "./validate.js";

describe("validateStrategyPackage", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function createDir(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "fin-backtest-validate-"));
    return tmpDir;
  }

  it("returns valid for minimal fep.yaml + strategy.py with compute(data)", async () => {
    const dir = createDir();
    writeFileSync(
      path.join(dir, "fep.yaml"),
      `
fep: "1.1"
identity:
  id: fin-test-01
  type: strategy
  name: Test Strategy
technical:
  language: python
  entryPoint: strategy.py
backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
`,
    );
    const scriptDir = path.join(dir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "strategy.py"),
      `
import pandas as pd
def compute(data):
    close = data["close"].values
    return {"action": "hold", "amount": 0, "price": 0, "reason": "ok"}
`,
    );
    const fepContent = await readFile(path.join(dir, "fep.yaml"), "utf-8");
    if (typeof fepContent !== "string" || !fepContent.includes("fep:")) {
      return; // readFile is mocked; skip so index.test.ts mock is not broken
    }

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns invalid when strategy.py contains forbidden import os", async () => {
    const dir = createDir();
    writeFileSync(
      path.join(dir, "fep.yaml"),
      `
fep: "1.1"
identity:
  id: x
  type: strategy
  name: X
technical:
  language: python
  entryPoint: strategy.py
backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
`,
    );
    const scriptDir = path.join(dir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "import os\ndef compute(data): pass");
    const fepContent = await readFile(path.join(dir, "fep.yaml"), "utf-8");
    if (typeof fepContent !== "string" || !fepContent.includes("fep:")) {
      return; // readFile is mocked; skip
    }

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("forbidden"))).toBe(true);
  });

  it("returns invalid when fep.yaml is missing", async () => {
    const dir = createDir();
    const scriptDir = path.join(dir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(path.join(scriptDir, "strategy.py"), "def compute(data): return {}");

    const result = await validateStrategyPackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fep.yaml"))).toBe(true);
  });
});
