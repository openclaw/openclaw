// Tokenomics tests cover usage mapping, ledger persistence, pricing fallback,
// and the free-vs-paid report.
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── fs spy for verifying no fd leak on oversized files ──
const fsSpy = { openCount: 0, closeCount: 0, throwOnAppend: false };
function resetFsSpy() {
  fsSpy.openCount = 0;
  fsSpy.closeCount = 0;
  fsSpy.throwOnAppend = false;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
      fsSpy.openCount++;
      return actual.openSync(...args);
    }),
    closeSync: vi.fn((...args: Parameters<typeof actual.closeSync>) => {
      fsSpy.closeCount++;
      return actual.closeSync(...args);
    }),
    appendFileSync: vi.fn((...args: Parameters<typeof actual.appendFileSync>) => {
      if (fsSpy.throwOnAppend) {
        throw new Error("ENOSPC: no space left on device");
      }
      return actual.appendFileSync(...args);
    }),
  };
});

import { buildFinOpsReport, type TaggedLedgerEntry } from "./finops.js";
import { HostAdapter, ingest, resolveCost } from "./host-adapter.js";
import { Ledger } from "./ledger.js";
import {
  PricingCatalog,
  validateModelPrice,
  validatePricingFile,
  getProcessUid,
  isPosixPlatform,
} from "./pricing.js";
import { renderReport, shareBar } from "./render.js";
import { buildReport, parseGran } from "./report.js";
import { createTokenomicsService, testApi, toUsageEvent } from "./service.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenomics-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("toUsageEvent", () => {
  it("forwards the host-reported cost verbatim (host truth wins)", () => {
    const ev = toUsageEvent({
      provider: "anthropic",
      model: "claude-x",
      usage: { input: 100, output: 50 },
      costUsd: 0.0123,
    });
    expect(ev).toMatchObject({
      provider: "anthropic",
      model: "claude-x",
      tokensIn: 100,
      tokensOut: 50,
    });
    expect(ev.costUsd).toBe(0.0123);
  });

  it("falls back to raw input and omits cost when absent", () => {
    const ev = toUsageEvent({ model: "m", usage: { input: 42 } });
    expect(ev.tokensIn).toBe(42);
    expect(ev.tokensOut).toBe(0);
    expect(ev.costUsd).toBeUndefined();
    expect(ev.provider).toBe("unknown");
  });

  it("prefers promptTokens so cache-read/write tokens are not dropped", () => {
    // Host sets promptTokens = input + cacheRead + cacheWrite (e.g. 100 + 60).
    const ev = toUsageEvent({ model: "m", usage: { input: 100, promptTokens: 160, output: 20 } });
    expect(ev.tokensIn).toBe(160);
    expect(ev.tokensOut).toBe(20);
  });
});

describe("parseBound", () => {
  it("snaps a date-only until to end-of-day (inclusive whole day)", () => {
    const until = testApi.parseBound("2026-06-30", "until");
    expect(until?.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });

  it("keeps a date-only since at start-of-day", () => {
    const since = testApi.parseBound("2026-06-01", "since");
    expect(since?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("honors an explicit datetime verbatim for both bounds", () => {
    const until = testApi.parseBound("2026-06-30T12:00:00.000Z", "until");
    expect(until?.toISOString()).toBe("2026-06-30T12:00:00.000Z");
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(testApi.parseBound(null, "until")).toBeUndefined();
    expect(testApi.parseBound("not-a-date", "since")).toBeUndefined();
  });
});

describe("validateModelPrice / PricingCatalog.load schema validation", () => {
  it("accepts a valid model price entry", () => {
    const { valid, warnings } = validateModelPrice("ok", {
      input_usd_per_mtok: 3,
      output_usd_per_mtok: 15,
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("rejects a non-object entry", () => {
    const { valid, warnings } = validateModelPrice("bad", "not-an-object");
    expect(valid).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not an object");
  });

  it("rejects null entry", () => {
    const { valid } = validateModelPrice("n", null);
    expect(valid).toBe(false);
  });

  it("rejects an array entry", () => {
    const { valid } = validateModelPrice("arr", [1, 2, 3]);
    expect(valid).toBe(false);
  });

  it("warns and drops non-numeric rate fields", () => {
    const { valid, warnings } = validateModelPrice("str", {
      input_usd_per_mtok: "free",
      output_usd_per_mtok: 15,
    } as Record<string, unknown>);
    expect(valid).toBe(true); // output_usd_per_mtok survives
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes("input_usd_per_mtok"))).toBe(true);
  });

  it("skips the model when no rate fields remain after cleaning", () => {
    const { valid, warnings } = validateModelPrice("noprice", {
      input_usd_per_mtok: "nope",
      output_usd_per_mtok: Number.NaN,
      source: 42,
    } as Record<string, unknown>);
    expect(valid).toBe(false);
    expect(warnings.some((w) => w.includes("no valid rate fields"))).toBe(true);
  });

  it("warns about non-string source field", () => {
    const { valid, warnings } = validateModelPrice("src", {
      input_usd_per_mtok: 3,
      source: 123,
    } as Record<string, unknown>);
    expect(valid).toBe(true); // still has a rate
    expect(warnings.some((w) => w.includes("source"))).toBe(true);
  });

  it("drops negative rate values silently as an unpriced sentinel", () => {
    const { valid, warnings } = validateModelPrice("neg", {
      usd_per_mtok: -5,
    });
    expect(valid).toBe(false);
    // Finite-negative is an intentional "unpriced" sentinel (e.g. -1000000),
    // not malformed input, so no per-field warning should be emitted for it.
    expect(warnings.some((w) => w.includes("is not a finite number"))).toBe(false);
    // The model is still skipped because no real rate field remains.
    expect(warnings.some((w) => w.includes("no valid rate fields"))).toBe(true);
  });

  it("PricingCatalog.load skips malformed entries and keeps valid ones", () => {
    const path = join(dir, "pricing-bad.json");
    writeFileSync(
      path,
      JSON.stringify({
        models: {
          good: { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
          badStr: { input_usd_per_mtok: "free" },
          badNull: null,
          badArr: [1, 2],
          alsoGood: { usd_per_mtok: 0.5 },
        },
        baseline_usd_per_mtok: "not-a-number",
        baseline_model: 42,
      }),
    );
    // Fixture must not be group/world-writable, or the permission gate rejects it before
    // the skip-malformed path under test (writeFileSync honors umask; CI=022, but 002 → 664).
    chmodSync(path, 0o600);
    const cat = PricingCatalog.load(path);
    expect(cat.models.size).toBe(2);
    expect(cat.models.has("good")).toBe(true);
    expect(cat.models.has("alsoGood")).toBe(true);
    expect(cat.models.has("badStr")).toBe(false);
    expect(cat.models.has("badNull")).toBe(false);
    expect(cat.models.has("badArr")).toBe(false);
    expect(cat.baselineUsdPerMtok).toBe(0);
    expect(cat.baselineModel).toBe("");
  });

  it("PricingCatalog.load returns empty catalog for absent file", () => {
    const cat = PricingCatalog.load(join(dir, "nonexistent.json"));
    expect(cat.models.size).toBe(0);
    expect(cat.baselineUsdPerMtok).toBe(0);
  });

  it("PricingCatalog.load returns empty catalog for unparseable JSON", () => {
    const path = join(dir, "bad-json.json");
    writeFileSync(path, "not json at all {{{");
    // 0600 so the parse path is exercised, not the permission gate (umask-independent).
    chmodSync(path, 0o600);
    const cat = PricingCatalog.load(path);
    expect(cat.models.size).toBe(0);
  });
});

describe("PricingCatalog.lookup tolerance", () => {
  function makeCatalog() {
    const cat = new PricingCatalog();
    cat.models.set("openai/gpt-4o", { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 });
    cat.models.set("claude-sonnet-4-6", { input_usd_per_mtok: 3, output_usd_per_mtok: 15 });
    cat.models.set("local-llama-8b", { usd_per_mtok: 0 });
    return cat;
  }

  it("returns the exact match when the model id matches verbatim", () => {
    const cat = makeCatalog();
    const p = cat.lookup("openai/gpt-4o");
    expect(p?.input_usd_per_mtok).toBe(2.5);
    expect(p?.output_usd_per_mtok).toBe(10);
  });

  it("returns undefined for an unrecognized model", () => {
    const cat = makeCatalog();
    expect(cat.lookup("nonexistent-model")).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const cat = makeCatalog();
    const p = cat.lookup("OPENAI/GPT-4O");
    expect(p?.input_usd_per_mtok).toBe(2.5);
    const p2 = cat.lookup("Claude-Sonnet-4-6");
    expect(p2?.input_usd_per_mtok).toBe(3);
    const p3 = cat.lookup("LOCAL-LLAMA-8B");
    expect(p3?.usd_per_mtok).toBe(0);
  });

  it("matches by leaf / suffix (drops host prefix)", () => {
    const cat = makeCatalog();
    // "claude-sonnet-4-6" is registered as-is; lookup with host prefix should match
    const p = cat.lookup("anthropic/claude-sonnet-4-6");
    expect(p?.input_usd_per_mtok).toBe(3);
    // Reverse: registered with host prefix, lookup without
    const p2 = cat.lookup("gpt-4o");
    expect(p2?.input_usd_per_mtok).toBe(2.5);
  });

  it("matches when lookup ends with a registered key (suffix)", () => {
    const cat = makeCatalog();
    // "gpt-4o" suffix matches "openai/gpt-4o" (ml.endsWith(kl))
    const p = cat.lookup("acme/gpt-4o");
    expect(p?.input_usd_per_mtok).toBe(2.5);
  });
});

describe("validatePricingFile / PricingCatalog.load permission checks", () => {
  const validPricingJson = JSON.stringify({
    models: { m: { input_usd_per_mtok: 3 } },
  });

  function writeSecure(path: string): void {
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o600);
  }

  it("PricingCatalog.load accepts a 0o600 file owned by the process user", () => {
    const path = join(dir, "secure.json");
    writeSecure(path);
    // On macOS/Linux CI, the test process owns the temp file; on Windows,
    // validatePricingFile skips the ownership check.
    const cat = PricingCatalog.load(path);
    expect(cat.models.size).toBe(1);
  });

  it("validatePricingFile rejects group-writable files (0o620)", () => {
    const path = join(dir, "group-writable.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o620);
    const result = validatePricingFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insecure mode");
    }
  });

  it("validatePricingFile rejects world-writable files (0o622)", () => {
    const path = join(dir, "world-writable.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o622);
    const result = validatePricingFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insecure mode");
    }
  });

  it("validatePricingFile rejects world-writable files (0o606)", () => {
    const path = join(dir, "world-rw.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o606);
    const result = validatePricingFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insecure mode");
    }
  });

  it("validatePricingFile accepts read-only for owner (0o400)", () => {
    const path = join(dir, "readonly.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o400);
    const result = validatePricingFile(path);
    expect(result.ok).toBe(true);
  });

  it("PricingCatalog.load returns empty catalog for group-writable file", () => {
    const path = join(dir, "pricing-group-write.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o620);
    const cat = PricingCatalog.load(path);
    expect(cat.models.size).toBe(0);
  });

  it("PricingCatalog.load returns empty catalog for world-writable file", () => {
    const path = join(dir, "pricing-world-write.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o622);
    const cat = PricingCatalog.load(path);
    expect(cat.models.size).toBe(0);
  });

  it("PricingCatalog.load returns empty catalog when file is a directory", () => {
    const cat = PricingCatalog.load(dir); // dir is a directory
    expect(cat.models.size).toBe(0);
  });

  it("getProcessUid returns a number on POSIX or undefined on Windows", () => {
    const uid = getProcessUid();
    expect(uid === undefined || (typeof uid === "number" && uid >= 0)).toBe(true);
  });

  it("isPosixPlatform returns true on macOS/Linux and false on win32", () => {
    // On this CI (macOS) expect true; the function is pure logic.
    expect(isPosixPlatform()).toBe(process.platform !== "win32");
  });

  it("validatePricingFile skips mode checks on Windows — accepts 0o622", () => {
    // On Windows, stat.mode typically includes write bits for everyone,
    // so we must skip the POSIX mode check. Simulate by passing posix=false.
    const path = join(dir, "windows-mode.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o622); // would be rejected on POSIX

    const result = validatePricingFile(path, { posix: false });
    expect(result.ok).toBe(true);
  });

  it("PricingCatalog.load accepts the file on simulated Windows", () => {
    const path = join(dir, "win-catalog.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o622); // would be rejected on POSIX

    const cat = PricingCatalog.load(path, { posix: false });
    expect(cat.models.size).toBe(1);
  });

  it("PricingCatalog.load writes a warning to stderr for insecure file permissions", () => {
    const path = join(dir, "pricing-stderr-warn.json");
    writeFileSync(path, validPricingJson);
    chmodSync(path, 0o622); // world-writable → rejected

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // Intercept process.stderr.write to capture warnings without printing them.
    const restore = () => {
      process.stderr.write = orig;
    };
    process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      const msg = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;

    let cat: PricingCatalog;
    try {
      cat = PricingCatalog.load(path);
    } finally {
      restore();
    }
    expect(cat.models.size).toBe(0);
    expect(captured.some((m) => m.includes("insecure mode"))).toBe(true);
    expect(captured.some((m) => m.includes(path))).toBe(true);
  });

  it("PricingCatalog.load warns on stderr for unreadable JSON", () => {
    const path = join(dir, "bad-json-stderr.json");
    writeFileSync(path, "{{{ not json");
    // 0600 so the "unreadable" parse warning fires, not the permission-gate warning.
    chmodSync(path, 0o600);

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    const restore = () => {
      process.stderr.write = orig;
    };
    process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      const msg = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;

    let cat: PricingCatalog;
    try {
      cat = PricingCatalog.load(path);
    } finally {
      restore();
    }
    expect(cat.models.size).toBe(0);
    expect(captured.some((m) => m.includes("unreadable"))).toBe(true);
  });

  it("PricingCatalog.load warns on stderr for oversized file", () => {
    const path = join(dir, "giant-pricing.json");
    // Write a file larger than 2 MiB.
    const header = '{"models":{';
    const footer = '"m":{"input_usd_per_mtok":1}}}';
    const pad = " ".repeat(2_200_000);
    writeFileSync(path, header + pad + footer);

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    const restore = () => {
      process.stderr.write = orig;
    };
    process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      const msg = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;

    let cat: PricingCatalog;
    try {
      cat = PricingCatalog.load(path);
    } finally {
      restore();
    }
    expect(cat.models.size).toBe(0);
    expect(captured.some((m) => m.includes("exceeds"))).toBe(true);
  });

  it("never opens or leaks a file descriptor on oversized files (size gate before openSync)", () => {
    resetFsSpy();
    const path = join(dir, "oversized-noleak.json");
    const pad = " ".repeat(2_200_000);
    writeFileSync(path, '{"models":{"m":{"input_usd_per_mtok":1}}}' + pad);
    // Confirm the file is oversized.
    expect(statSync(path).size).toBeGreaterThan(2_097_152);

    const cat = PricingCatalog.load(path);

    // Size gate rejects the file before openSync is ever called → no fd leak.
    expect(fsSpy.openCount).toBe(0);
    expect(fsSpy.closeCount).toBe(0);
    expect(cat.models.size).toBe(0);
  });
});

describe("resolveCost precedence", () => {
  const pricing = (() => {
    const p = new PricingCatalog();
    p.models.set("paid-model", { input_usd_per_mtok: 3, output_usd_per_mtok: 15 });
    return p;
  })();

  it("uses explicit costUsd when present", () => {
    expect(
      resolveCost(
        { provider: "p", model: "paid-model", tokensIn: 1000, tokensOut: 1000, costUsd: 9 },
        { pricing },
      ),
    ).toBe(9);
  });

  it("treats free-classified models as $0 even when priced", () => {
    expect(
      resolveCost(
        { provider: "p", model: "paid-model", tokensIn: 1_000_000, tokensOut: 0, free: true },
        { pricing },
      ),
    ).toBe(0);
  });

  it("estimates from the catalog when no cost is given", () => {
    // 1M input @ $3/Mtok + 1M output @ $15/Mtok = $18
    expect(
      resolveCost(
        { provider: "p", model: "paid-model", tokensIn: 1_000_000, tokensOut: 1_000_000 },
        { pricing },
      ),
    ).toBeCloseTo(18, 6);
  });

  it("never invents cost for an unknown model", () => {
    expect(
      resolveCost(
        { provider: "p", model: "mystery", tokensIn: 1_000_000, tokensOut: 0 },
        { pricing },
      ),
    ).toBe(0);
  });
});

describe("ledger persistence", () => {
  it("appends one tolerant JSONL row per call and reads it back", () => {
    const path = join(dir, "ledger.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "openai",
      model: "gpt-x",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.5,
      tsUtc: "2026-06-10T00:00:00.000Z",
    });
    ingest(ledger, {
      provider: "openai",
      model: "gpt-x",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-11T00:00:00.000Z",
    });
    const rows = ledger.entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: "openai", model: "gpt-x", cost_usd: 0.5 });
  });

  it("skips malformed JSONL lines and fires onMalformed with the correct count", () => {
    const path = join(dir, "ledger-malformed.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          ts_utc: "2026-06-10T12:00:00.000Z",
          provider: "openai",
          model: "gpt-x",
          tokens_in: 10,
          tokens_out: 5,
          cost_usd: 0.5,
        }),
        "", // blank line (fine)
        "{broken json", // unparseable
        JSON.stringify({ ts_utc: "2026-06-11T00:00:00.000Z", provider: "x", model: "y" }), // missing numeric fields → malformed
        "null", // parses but not a valid entry object
        JSON.stringify({
          ts_utc: "2026-06-12T00:00:00.000Z",
          provider: "a",
          model: "b",
          tokens_in: 1,
          tokens_out: 1,
          cost_usd: 0,
        }),
      ].join("\n") + "\n",
    );

    let malformedCount = -1;
    const ledger = new Ledger(path, {
      onMalformed: (count) => {
        malformedCount = count;
      },
    });
    const rows = ledger.entries();
    // Valid rows: line 1 (gpt-x), line 6 (a/b)
    expect(rows).toHaveLength(2);
    // Malformed: "{broken json" (parse), missing-numeric-fields, "null"
    expect(malformedCount).toBe(3);
  });

  it("skips rows with missing or non-finite numeric fields (NaN safeguard)", () => {
    const path = join(dir, "ledger-nan.jsonl");
    writeFileSync(
      path,
      [
        // missing tokens_in
        JSON.stringify({
          ts_utc: "2026-06-10T12:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_out: 5,
          cost_usd: 0,
        }),
        // missing tokens_out
        JSON.stringify({
          ts_utc: "2026-06-10T13:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_in: 10,
          cost_usd: 0,
        }),
        // missing cost_usd
        JSON.stringify({
          ts_utc: "2026-06-10T14:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_in: 10,
          tokens_out: 5,
        }),
        // tokens_in is null (JSON encodes Infinity as null)
        JSON.stringify({
          ts_utc: "2026-06-10T15:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_in: null,
          tokens_out: 5,
          cost_usd: 0,
        }),
        // cost_usd is a string
        JSON.stringify({
          ts_utc: "2026-06-10T17:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_in: 10,
          tokens_out: 5,
          cost_usd: "0.00",
        }),
        // all valid (sanity: not everything is malformed)
        JSON.stringify({
          ts_utc: "2026-06-10T18:00:00.000Z",
          provider: "x",
          model: "m",
          tokens_in: 10,
          tokens_out: 5,
          cost_usd: 0,
        }),
      ].join("\n") + "\n",
    );

    let malformedCount = 0;
    const ledger = new Ledger(path, {
      onMalformed: (count) => {
        malformedCount = count;
      },
    });
    const rows = ledger.entries();
    expect(rows).toHaveLength(1); // only the last line is valid
    expect(rows[0].ts_utc).toBe("2026-06-10T18:00:00.000Z");
    expect(malformedCount).toBe(5);
  });

  it("onMalformed is not called when all lines are valid", () => {
    const path = join(dir, "ledger-valid.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        ts_utc: "2026-06-10T12:00:00.000Z",
        provider: "o",
        model: "m",
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
      }) + "\n",
    );
    let called = false;
    const ledger = new Ledger(path, {
      onMalformed: () => {
        called = true;
      },
    });
    ledger.entries();
    expect(called).toBe(false);
  });

  it("returns empty array when the ledger file does not exist", () => {
    const ledger = new Ledger(join(dir, "nonexistent.jsonl"));
    expect(ledger.entries()).toEqual([]);
  });

  it("creates the parent directory lazily on first record", () => {
    const sub = join(dir, "nested", "deep", "ledger.jsonl");
    // Verify the parent does not exist yet.
    expect(existsSync(dirname(sub))).toBe(false);
    const ledger = new Ledger(sub);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    });
    expect(existsSync(dirname(sub))).toBe(true);
    const stat = statSync(dirname(sub));
    expect(stat.isDirectory()).toBe(true);
    const rows = ledger.entries();
    expect(rows).toHaveLength(1);
  });

  it("calls onError when appendFileSync throws (disk full etc.) and does not crash", () => {
    const path = join(dir, "ledger-error.jsonl");
    let errorCaught: unknown = undefined;
    const ledger = new Ledger(path, {
      onError: (err) => {
        errorCaught = err;
      },
    });

    fsSpy.throwOnAppend = true;
    try {
      const entry = ingest(ledger, {
        provider: "test",
        model: "m",
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      });
      // ingest returns the entry even when the write fails
      expect(entry).toBeDefined();
      expect(entry.model).toBe("m");
    } finally {
      fsSpy.throwOnAppend = false;
    }

    expect(errorCaught).toBeDefined();
    expect(String(errorCaught)).toContain("ENOSPC");
    // The file was never written, so entries() returns empty
    expect(ledger.entries()).toHaveLength(0);
  });

  it("host field is persisted in the ledger entry when provided", () => {
    const path = join(dir, "ledger-host.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "openai",
      model: "gpt-x",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.5,
      host: "codex",
    });
    const rows = ledger.entries();
    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBe("codex");
  });
});

describe("ledger window filtering", () => {
  it("entriesIn includes entries on both window boundaries (inclusive)", () => {
    const path = join(dir, "ledger-window-in.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-01T00:00:00.000Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-30T23:59:59.999Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-15T12:00:00.000Z",
    });

    const rows = ledger.entriesIn(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.999Z"),
    );
    expect(rows).toHaveLength(3);
  });

  it("entriesIn excludes entries strictly before the window", () => {
    const path = join(dir, "ledger-before.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-05-31T23:59:59.999Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-15T12:00:00.000Z",
    });

    const rows = ledger.entriesIn(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.999Z"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ts_utc).toBe("2026-06-15T12:00:00.000Z");
  });

  it("entriesIn excludes entries strictly after the window", () => {
    const path = join(dir, "ledger-after.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-07-01T00:00:00.000Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-15T12:00:00.000Z",
    });

    const rows = ledger.entriesIn(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.999Z"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ts_utc).toBe("2026-06-15T12:00:00.000Z");
  });

  it("entriesIn with only a since bound excludes earlier entries", () => {
    const path = join(dir, "ledger-since-only.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-01T00:00:00.000Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-05-31T00:00:00.000Z",
    });

    const rows = ledger.entriesIn(new Date("2026-06-01T00:00:00.000Z"), undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts_utc).toBe("2026-06-01T00:00:00.000Z");
  });

  it("entriesIn with only an until bound excludes later entries", () => {
    const path = join(dir, "ledger-until-only.jsonl");
    const ledger = new Ledger(path);
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-06-30T23:59:59.999Z",
    });
    ingest(ledger, {
      provider: "test",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      tsUtc: "2026-07-01T00:00:00.000Z",
    });

    const rows = ledger.entriesIn(undefined, new Date("2026-06-30T23:59:59.999Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0].ts_utc).toBe("2026-06-30T23:59:59.999Z");
  });
});

describe("buildReport free-vs-paid", () => {
  it("splits free and paid tokens and computes avoided/counterfactual", () => {
    const adapter = new HostAdapter(join(dir, "ledger.jsonl"), "openclaw");
    // paid call: $0.20, 1000 tokens
    adapter.track({
      provider: "anthropic",
      model: "paid",
      tokensIn: 600,
      tokensOut: 400,
      costUsd: 0.2,
      tsUtc: "2026-06-10T12:00:00.000Z",
    });
    // free call: $0, 2000 tokens
    adapter.track({
      provider: "local",
      model: "free",
      tokensIn: 1500,
      tokensOut: 500,
      costUsd: 0,
      tsUtc: "2026-06-10T13:00:00.000Z",
    });

    const pricing = new PricingCatalog();
    pricing.baselineModel = "frontier";
    pricing.baselineUsdPerMtok = 10; // $10 / Mtok

    const rep = buildReport({
      ledger: adapter.ledger,
      pricing,
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-06-30T23:59:59.000Z"),
      gran: "day",
    });

    expect(rep.total_calls).toBe(2);
    expect(rep.total_tokens).toBe(3000);
    expect(rep.total_cost_usd).toBeCloseTo(0.2, 6);
    expect(rep.free_tokens).toBe(2000);
    expect(rep.billed_tokens).toBe(1000);
    // avoided = 2000 free tokens @ $10/Mtok = $0.02
    expect(rep.avoided_usd).toBeCloseTo(0.02, 6);
    // counterfactual = 3000 tokens @ $10/Mtok = $0.03
    expect(rep.counterfactual_usd).toBeCloseTo(0.03, 6);

    const paid = rep.by_model.find((r) => r.model === "paid");
    const free = rep.by_model.find((r) => r.model === "free");
    expect(paid?.billed).toBe(true);
    expect(free?.billed).toBe(false);
  });

  it("derives the baseline from observed paid spend when no catalog baseline is set", () => {
    const adapter = new HostAdapter(join(dir, "ledger.jsonl"), "openclaw");
    // paid: $0.20 over 1000 tokens => effective 200 $/Mtok
    adapter.track({
      provider: "anthropic",
      model: "paid",
      tokensIn: 600,
      tokensOut: 400,
      costUsd: 0.2,
      tsUtc: "2026-06-10T12:00:00.000Z",
    });
    // free: 2000 tokens
    adapter.track({
      provider: "local",
      model: "free",
      tokensIn: 1500,
      tokensOut: 500,
      costUsd: 0,
      tsUtc: "2026-06-10T13:00:00.000Z",
    });

    // Empty catalog: no baseline override -> derive from observed spend.
    const rep = buildReport({
      ledger: adapter.ledger,
      pricing: new PricingCatalog(),
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-06-30T23:59:59.000Z"),
      gran: "day",
    });

    expect(rep.baseline_model).toBe("paid");
    expect(rep.baseline_usd_per_mtok).toBeCloseTo(200, 6);
    // avoided = 2000 free tokens @ derived 200/Mtok = $0.40
    expect(rep.avoided_usd).toBeCloseTo(0.4, 6);
    // counterfactual = 3000 tokens @ 200/Mtok = $0.60
    expect(rep.counterfactual_usd).toBeCloseTo(0.6, 6);
  });

  it("selects the highest effective $/Mtok among multiple paid models when deriving baseline", () => {
    const adapter = new HostAdapter(join(dir, "ledger.jsonl"), "openclaw");
    // Model A: $0.15 over 1000 tokens → effective 150 $/Mtok
    adapter.track({
      provider: "anthropic",
      model: "model-a",
      tokensIn: 500,
      tokensOut: 500,
      costUsd: 0.15,
      tsUtc: "2026-06-10T12:00:00.000Z",
    });
    // Model B: $0.40 over 1000 tokens → effective 400 $/Mtok (highest)
    adapter.track({
      provider: "openai",
      model: "model-b",
      tokensIn: 800,
      tokensOut: 200,
      costUsd: 0.4,
      tsUtc: "2026-06-10T13:00:00.000Z",
    });
    // Model C: $0.08 over 800 tokens → effective 100 $/Mtok
    adapter.track({
      provider: "openrouter",
      model: "model-c",
      tokensIn: 400,
      tokensOut: 400,
      costUsd: 0.08,
      tsUtc: "2026-06-10T14:00:00.000Z",
    });
    // Free model — should not affect the baseline
    adapter.track({
      provider: "local",
      model: "free-model",
      tokensIn: 2000,
      tokensOut: 1000,
      costUsd: 0,
      tsUtc: "2026-06-10T15:00:00.000Z",
    });

    const rep = buildReport({
      ledger: adapter.ledger,
      pricing: new PricingCatalog(),
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-06-30T23:59:59.000Z"),
      gran: "day",
    });

    // Model B at 400 $/Mtok should be selected as the baseline.
    expect(rep.baseline_model).toBe("model-b");
    expect(rep.baseline_usd_per_mtok).toBeCloseTo(400, 6);
    // free tokens = 3000 @ 400/Mtok → $1.20 avoided
    expect(rep.avoided_usd).toBeCloseTo(1.2, 6);
  });
});

describe("buildReport time-bucket granularity", () => {
  it("buckets by hour when gran is 'hour'", () => {
    const adapter = new HostAdapter(join(dir, "ledger-hour.jsonl"), "openclaw");
    // Two entries at hour 08, one at hour 14 on the same day
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.1,
      tsUtc: "2026-06-10T08:30:00.000Z",
    });
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.2,
      tsUtc: "2026-06-10T08:45:00.000Z",
    });
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 300,
      tokensOut: 150,
      costUsd: 0.3,
      tsUtc: "2026-06-10T14:00:00.000Z",
    });

    const rep = buildReport({
      ledger: adapter.ledger,
      pricing: new PricingCatalog(),
      since: new Date("2026-06-10T00:00:00.000Z"),
      until: new Date("2026-06-10T23:59:59.999Z"),
      gran: "hour",
    });

    expect(rep.bucket_gran).toBe("hour");
    expect(rep.buckets).toHaveLength(2);
    const h08 = rep.buckets.find((b) => b.key === "2026-06-10 08:00");
    const h14 = rep.buckets.find((b) => b.key === "2026-06-10 14:00");
    expect(h08).toBeDefined();
    expect(h08!.calls).toBe(2);
    expect(h08!.tokens_in).toBe(300);
    expect(h08!.tokens_out).toBe(150);
    expect(h08!.cost_usd).toBeCloseTo(0.3, 6);
    expect(h14).toBeDefined();
    expect(h14!.calls).toBe(1);
    expect(h14!.tokens_in).toBe(300);
    expect(h14!.tokens_out).toBe(150);
  });

  it("buckets by week when gran is 'week' with ISO week keys", () => {
    const adapter = new HostAdapter(join(dir, "ledger-week.jsonl"), "openclaw");
    // 2026-06-10 (Wed) → ISO week 24
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.5,
      tsUtc: "2026-06-10T12:00:00.000Z",
    });
    // 2026-06-16 (Tue) → ISO week 25
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.6,
      tsUtc: "2026-06-16T12:00:00.000Z",
    });
    // 2026-06-22 (Mon) → ISO week 26
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 300,
      tokensOut: 150,
      costUsd: 0.7,
      tsUtc: "2026-06-22T12:00:00.000Z",
    });

    const rep = buildReport({
      ledger: adapter.ledger,
      pricing: new PricingCatalog(),
      since: new Date("2026-06-01T00:00:00.000Z"),
      until: new Date("2026-06-30T23:59:59.999Z"),
      gran: "week",
    });

    expect(rep.bucket_gran).toBe("week");
    // At least 2 distinct weeks (some dates might group, but 10th, 16th, 22nd are different weeks)
    expect(rep.buckets.length).toBeGreaterThanOrEqual(2);
    for (const b of rep.buckets) {
      expect(b.key).toMatch(/^\d{4}-W\d{2}$/);
    }
    // Verify sorted order
    const keys = rep.buckets.map((b) => b.key);
    expect([...keys].toSorted()).toEqual(keys);
  });

  it("buckets by month when gran is 'month' and aggregates across month boundaries", () => {
    const adapter = new HostAdapter(join(dir, "ledger-month.jsonl"), "openclaw");
    // May 2026
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.1,
      tsUtc: "2026-05-15T12:00:00.000Z",
    });
    // June 2026 (two calls)
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.2,
      tsUtc: "2026-06-01T12:00:00.000Z",
    });
    adapter.track({
      provider: "test",
      model: "m",
      tokensIn: 300,
      tokensOut: 150,
      costUsd: 0.3,
      tsUtc: "2026-06-30T23:59:59.999Z",
    });

    const rep = buildReport({
      ledger: adapter.ledger,
      pricing: new PricingCatalog(),
      since: new Date("2026-05-01T00:00:00.000Z"),
      until: new Date("2026-06-30T23:59:59.999Z"),
      gran: "month",
    });

    expect(rep.bucket_gran).toBe("month");
    expect(rep.buckets).toHaveLength(2);
    const may = rep.buckets.find((b) => b.key === "2026-05");
    const june = rep.buckets.find((b) => b.key === "2026-06");
    expect(may).toBeDefined();
    expect(may!.calls).toBe(1);
    expect(may!.tokens_in).toBe(100);
    expect(may!.tokens_out).toBe(50);
    expect(may!.cost_usd).toBeCloseTo(0.1, 6);
    expect(june).toBeDefined();
    expect(june!.calls).toBe(2);
    expect(june!.tokens_in).toBe(500);
    expect(june!.tokens_out).toBe(250);
    expect(june!.cost_usd).toBeCloseTo(0.5, 6);
  });
});

describe("parseGran", () => {
  it("returns 'hour' for 'hour' and 'hourly'", () => {
    expect(parseGran("hour")).toBe("hour");
    expect(parseGran("hourly")).toBe("hour");
  });

  it("returns 'day' for 'day' and 'daily'", () => {
    expect(parseGran("day")).toBe("day");
    expect(parseGran("daily")).toBe("day");
  });

  it("returns 'week' for 'week' and 'weekly'", () => {
    expect(parseGran("week")).toBe("week");
    expect(parseGran("weekly")).toBe("week");
  });

  it("returns 'month' for 'month' and 'monthly'", () => {
    expect(parseGran("month")).toBe("month");
    expect(parseGran("monthly")).toBe("month");
  });

  it("defaults to 'day' for unknown inputs (e.g. 'foobar')", () => {
    expect(parseGran("foobar")).toBe("day");
    expect(parseGran("")).toBe("day");
    expect(parseGran("unknown")).toBe("day");
  });

  it("is case-insensitive", () => {
    expect(parseGran("WEEK")).toBe("week");
    expect(parseGran("Monthly")).toBe("month");
    expect(parseGran("HoUr")).toBe("hour");
  });
});

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  setHeader(k: string, v: string): void;
  end(chunk?: string): void;
}

function makeRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
      this.ended = true;
    },
  };
}

function callHandler(
  handler: ReturnType<typeof createTokenomicsService>["handler"],
  method: string,
  url: string,
): MockRes {
  const res = makeRes();
  // The handler only reads `method` and `url`; cast the minimal mocks. The
  // route resolves synchronously, so the boolean return is safe to ignore.
  void handler({ method, url } as never, res as never);
  return res;
}

describe("http handler", () => {
  function startService() {
    const svc = createTokenomicsService();
    const ctx = {
      stateDir: dir,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      // no internalDiagnostics: recording is skipped, but the route still serves
    };
    svc.service.start(ctx as never);
    return svc;
  }

  it("rejects non-GET/HEAD methods with 405", () => {
    const { handler } = startService();
    const res = callHandler(handler, "POST", "/");
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });

  it("returns 503 before the service has started", () => {
    const { handler } = createTokenomicsService();
    const res = callHandler(handler, "GET", "/");
    expect(res.statusCode).toBe(503);
  });

  it("returns 400 for an unparseable bound", () => {
    const { handler } = startService();
    const res = callHandler(handler, "GET", "/?until=not-a-date");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("until");
  });

  it("returns 400 when since is after until", () => {
    const { handler } = startService();
    const res = callHandler(handler, "GET", "/?since=2026-06-30&until=2026-06-01");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("since");
  });

  it("serves JSON by default and text on request", () => {
    const { handler } = startService();
    const json = callHandler(handler, "GET", "/");
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(() => JSON.parse(json.body)).not.toThrow();

    const text = callHandler(handler, "GET", "/?format=text");
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body.length).toBeGreaterThan(0);
  });

  it("answers HEAD with no body", () => {
    const { handler } = startService();
    const res = callHandler(handler, "HEAD", "/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it("reflects the period label in the JSON report when supplied", () => {
    const { handler } = startService();
    const res = callHandler(handler, "GET", "/?period=Q2%202026");
    expect(res.statusCode).toBe(200);
    const report = JSON.parse(res.body);
    expect(report.period).toBe("Q2 2026");
  });

  it("reflects the period label in the text report when supplied", () => {
    const { handler } = startService();
    const res = callHandler(handler, "GET", "/?format=text&period=Q2%202026");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Q2 2026");
  });
});

describe("usage recording", () => {
  function startWithDiagnostics() {
    const svc = createTokenomicsService();
    let emit: ((event: unknown, metadata: unknown) => void) | undefined;
    const warnings: string[] = [];
    const ctx = {
      stateDir: dir,
      logger: {
        info() {},
        debug() {},
        error() {},
        warn(msg: string) {
          warnings.push(msg);
        },
      },
      internalDiagnostics: {
        onEvent: (cb: (event: unknown, metadata: unknown) => void) => {
          emit = cb;
          return () => {};
        },
      },
    };
    svc.service.start(ctx as never);
    if (!emit) {
      throw new Error("service did not subscribe to diagnostics");
    }
    return { svc, emit, warnings };
  }

  function ledgerEntries() {
    return new Ledger(join(dir, "tokenomics", "ledger.jsonl")).entries();
  }

  it("records a usage event that carries token usage", () => {
    const { emit } = startWithDiagnostics();
    emit(
      {
        type: "model.usage",
        provider: "groq",
        model: "llama",
        usage: { input: 100, output: 50 },
        costUsd: 0,
      },
      { trusted: true },
    );
    const entries = ledgerEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "groq",
      model: "llama",
      tokens_in: 100,
      tokens_out: 50,
    });
  });

  it("skips and warns on a usage event with no tokens and no cost", () => {
    const { emit, warnings } = startWithDiagnostics();
    // Mirrors a streamed call where the provider omitted usage (the
    // supportsUsageInStreaming gap): no tokens, no cost.
    emit(
      { type: "model.usage", provider: "custom-enterprise", model: "custom-model", usage: {} },
      { trusted: true },
    );
    expect(ledgerEntries()).toHaveLength(0);
    expect(warnings.some((w) => w.includes("supportsUsageInStreaming"))).toBe(true);
  });

  it("still records a zero-cost call when tokens are present (free model)", () => {
    const { emit } = startWithDiagnostics();
    emit(
      {
        type: "model.usage",
        provider: "custom-enterprise",
        model: "free-model",
        usage: { input: 10, output: 20 },
        costUsd: 0,
      },
      { trusted: true },
    );
    const entries = ledgerEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].cost_usd).toBe(0);
  });
});

describe("renderReport honors NO_COLOR", () => {
  it("omits ANSI escape codes when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const rep = buildReport({
        ledger: new Ledger(join(dir, "ledger.jsonl")),
        pricing: new PricingCatalog(),
        since: new Date("2026-06-01"),
        until: new Date("2026-06-30T23:59:59.000Z"),
      });
      const out = renderReport(rep);
      // eslint-disable-next-line no-control-regex -- intentionally checking for ANSI escapes
      expect(out).not.toMatch(/\x1b\[/);
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });

  it("omits ANSI codes in shareBar when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const bar = shareBar(500, 1000);
      // eslint-disable-next-line no-control-regex -- intentionally checking for ANSI escapes
      expect(bar).not.toMatch(/\x1b\[/);
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });
});

describe("FinOps observability (finops.ts)", () => {
  it("buildFinOpsReport: allocation, realized rate, advisor, forecast", () => {
    const finopsDir = mkdtempSync(join(tmpdir(), "tok-finops-"));
    const led = new Ledger(join(finopsDir, "ledger.jsonl"));
    const now = new Date();
    const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    const rows: TaggedLedgerEntry[] = [
      {
        ts_utc: iso(2),
        provider: "openai",
        model: "gpt-4o",
        tokens_in: 1_000_000,
        tokens_out: 500_000,
        cost_usd: 7.5,
        caller: "agent-a",
        task: "build",
      },
      {
        ts_utc: iso(1),
        provider: "openai",
        model: "gpt-4o-mini",
        tokens_in: 2_000_000,
        tokens_out: 1_000_000,
        cost_usd: 0.9,
        caller: "agent-a",
        task: "review",
      },
      {
        ts_utc: iso(0),
        provider: "local",
        model: "local/free",
        tokens_in: 1_000_000,
        tokens_out: 1_000_000,
        cost_usd: 0,
        caller: "agent-b",
      },
    ];
    for (const r of rows) {
      led.record(r);
    }

    const pricing = new PricingCatalog();
    pricing.models.set("gpt-4o", { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 });
    pricing.models.set("gpt-4o-mini", { input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6 });

    const rep = buildFinOpsReport(led, pricing, {
      since: new Date(now.getTime() - 3 * 86_400_000),
      until: now,
    });

    expect(rep.total_calls).toBe(3);
    // Realized $/Mtok is computed from actual ledger spend.
    expect(
      rep.by_model_realized.find((m) => m.model === "gpt-4o")?.realized_usd_per_mtok,
    ).toBeGreaterThan(0);
    // Allocation groups both of agent-a's calls.
    expect(rep.by_caller.find((g) => g.key === "agent-a")?.calls).toBe(2);
    // Advisor is report-only and never proposes negative savings.
    expect(rep.advisor.every((a) => a.potential_savings_usd >= 0)).toBe(true);
    // Burn forecast saw at least one day of data.
    expect(rep.forecast.sample_days).toBeGreaterThanOrEqual(1);
  });
});
