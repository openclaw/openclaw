import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSavingsMetrics,
  fmtTokens,
  pct,
  readSavingsLedger,
  recordAdaptiveRun,
  savingsFilePath,
} from "./adaptive-routing-savings.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-savings-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true }).catch(() => {});
});

// ─── readSavingsLedger ───────────────────────────────────────────────────────

describe("readSavingsLedger", () => {
  it("returns empty ledger when file does not exist", async () => {
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.version).toBe(1);
    expect(ledger.totals.runsTotal).toBe(0);
    expect(ledger.totals.runsLocal).toBe(0);
    expect(ledger.totals.runsEscalated).toBe(0);
    expect(ledger.totals.runsBypassed).toBe(0);
  });

  it("returns empty ledger when file is malformed JSON", async () => {
    await fs.writeFile(savingsFilePath(tmpDir), "not-json", "utf8");
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsTotal).toBe(0);
  });

  it("merges missing fields from older schema", async () => {
    const partial = {
      version: 1,
      since: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      totals: { runsTotal: 5 },
    };
    await fs.writeFile(savingsFilePath(tmpDir), JSON.stringify(partial), "utf8");
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsTotal).toBe(5);
    expect(ledger.totals.runsLocal).toBe(0); // default filled in
  });
});

// ─── recordAdaptiveRun ───────────────────────────────────────────────────────

describe("recordAdaptiveRun", () => {
  it("increments runsBypassed for bypassed runs", async () => {
    await recordAdaptiveRun(tmpDir, { kind: "bypassed" });
    await recordAdaptiveRun(tmpDir, { kind: "bypassed" });
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsBypassed).toBe(2);
    expect(ledger.totals.runsTotal).toBe(0); // bypassed not counted in runsTotal
  });

  it("accumulates local_success runs and tokens", async () => {
    await recordAdaptiveRun(tmpDir, {
      kind: "local_success",
      localUsage: { input: 100, output: 40, cacheRead: 10 },
    });
    await recordAdaptiveRun(tmpDir, {
      kind: "local_success",
      localUsage: { input: 200, output: 80 },
    });
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsTotal).toBe(2);
    expect(ledger.totals.runsLocal).toBe(2);
    expect(ledger.totals.runsEscalated).toBe(0);
    expect(ledger.totals.localTokensInput).toBe(300);
    expect(ledger.totals.localTokensOutput).toBe(120);
    expect(ledger.totals.localTokensCacheRead).toBe(10);
    expect(ledger.totals.cloudTokensInput).toBe(0);
  });

  it("accumulates escalated runs with both local and cloud tokens", async () => {
    await recordAdaptiveRun(tmpDir, {
      kind: "escalated",
      localUsage: { input: 50, output: 20 },
      cloudUsage: { input: 400, output: 150 },
    });
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsTotal).toBe(1);
    expect(ledger.totals.runsLocal).toBe(0);
    expect(ledger.totals.runsEscalated).toBe(1);
    expect(ledger.totals.localTokensInput).toBe(50);
    expect(ledger.totals.localTokensOutput).toBe(20);
    expect(ledger.totals.cloudTokensInput).toBe(400);
    expect(ledger.totals.cloudTokensOutput).toBe(150);
  });

  it("handles undefined usage gracefully (defaults to 0)", async () => {
    await recordAdaptiveRun(tmpDir, { kind: "local_success" });
    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsLocal).toBe(1);
    expect(ledger.totals.localTokensInput).toBe(0);
  });

  it("mixes local_success and escalated across multiple runs", async () => {
    await recordAdaptiveRun(tmpDir, {
      kind: "local_success",
      localUsage: { input: 100, output: 50 },
    });
    await recordAdaptiveRun(tmpDir, {
      kind: "escalated",
      localUsage: { input: 80, output: 30 },
      cloudUsage: { input: 500, output: 200 },
    });
    await recordAdaptiveRun(tmpDir, {
      kind: "local_success",
      localUsage: { input: 120, output: 60 },
    });

    const ledger = await readSavingsLedger(tmpDir);
    expect(ledger.totals.runsTotal).toBe(3);
    expect(ledger.totals.runsLocal).toBe(2);
    expect(ledger.totals.runsEscalated).toBe(1);
    expect(ledger.totals.localTokensInput).toBe(300);
    expect(ledger.totals.localTokensOutput).toBe(140);
    expect(ledger.totals.cloudTokensInput).toBe(500);
    expect(ledger.totals.cloudTokensOutput).toBe(200);
  });

  it("creates stateDir if it does not exist", async () => {
    const nested = path.join(tmpDir, "deep", "nested");
    await recordAdaptiveRun(nested, { kind: "local_success" });
    const ledger = await readSavingsLedger(nested);
    expect(ledger.totals.runsLocal).toBe(1);
  });
});

// ─── computeSavingsMetrics ───────────────────────────────────────────────────

describe("computeSavingsMetrics", () => {
  it("returns zero stats for empty ledger", () => {
    const ledger = {
      version: 1 as const,
      since: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      totals: {
        runsTotal: 0,
        runsLocal: 0,
        runsEscalated: 0,
        runsBypassed: 0,
        localTokensInput: 0,
        localTokensOutput: 0,
        localTokensCacheRead: 0,
        cloudTokensInput: 0,
        cloudTokensOutput: 0,
      },
    };
    const m = computeSavingsMetrics(ledger);
    expect(m.runsTotal).toBe(0);
    expect(m.cloudSavedTokens).toBe(0);
    expect(m.savingsRate).toBe("—");
  });

  it("reports 100% savings rate when all runs are local", () => {
    const ledger = {
      version: 1 as const,
      since: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      totals: {
        runsTotal: 4,
        runsLocal: 4,
        runsEscalated: 0,
        runsBypassed: 0,
        localTokensInput: 400,
        localTokensOutput: 160,
        localTokensCacheRead: 0,
        cloudTokensInput: 0,
        cloudTokensOutput: 0,
      },
    };
    const m = computeSavingsMetrics(ledger);
    expect(m.savingsRate).toBe("100%");
    expect(m.cloudSavedTokens).toBe(560); // all local tokens saved from cloud
    expect(m.cloudTotal).toBe(0);
  });

  it("reports 0% savings rate when all runs escalated", () => {
    const ledger = {
      version: 1 as const,
      since: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      totals: {
        runsTotal: 3,
        runsLocal: 0,
        runsEscalated: 3,
        runsBypassed: 0,
        localTokensInput: 150,
        localTokensOutput: 60,
        localTokensCacheRead: 0,
        cloudTokensInput: 600,
        cloudTokensOutput: 300,
      },
    };
    const m = computeSavingsMetrics(ledger);
    expect(m.savingsRate).toBe("0%");
    expect(m.cloudSavedTokens).toBe(0);
    expect(m.cloudTotal).toBe(900);
  });

  it("proportionally allocates savings for mixed runs", () => {
    const ledger = {
      version: 1 as const,
      since: "2026-01-01T00:00:00Z",
      lastUpdated: "2026-01-01T00:00:00Z",
      totals: {
        runsTotal: 4,
        runsLocal: 3,
        runsEscalated: 1,
        runsBypassed: 2,
        localTokensInput: 400,
        localTokensOutput: 200,
        localTokensCacheRead: 0,
        cloudTokensInput: 500,
        cloudTokensOutput: 200,
      },
    };
    const m = computeSavingsMetrics(ledger);
    expect(m.savingsRate).toBe("75%"); // 3/4
    // cloudSavedTokens = (400+200) * (3/4) = 450
    expect(m.cloudSavedTokens).toBe(450);
    expect(m.localTotal).toBe(600);
    expect(m.cloudTotal).toBe(700);
  });
});

// ─── fmtTokens / pct ─────────────────────────────────────────────────────────

describe("fmtTokens", () => {
  it("formats sub-1k tokens as plain numbers", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(999_999)).toBe("1000.0k");
  });

  it("formats millions with M suffix", () => {
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(2_500_000)).toBe("2.50M");
  });
});

describe("pct", () => {
  it("returns — when denominator is zero", () => {
    expect(pct(0, 0)).toBe("—");
    expect(pct(5, 0)).toBe("—");
  });

  it("returns percentage string", () => {
    expect(pct(1, 4)).toBe("25%");
    expect(pct(3, 3)).toBe("100%");
    expect(pct(0, 5)).toBe("0%");
  });
});
