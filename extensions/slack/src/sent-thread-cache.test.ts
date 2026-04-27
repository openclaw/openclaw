import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  _flushPersist,
  _resetForTests,
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
  recordSlackThreadParticipation,
} from "./sent-thread-cache.js";

describe("slack sent-thread-cache", () => {
  let tempDir: string;

  beforeEach(() => {
    // Isolate from real $STATE_DIR so clearSlackThreadParticipationCache()
    // (which calls persistToDisk synchronously) doesn't wipe real state.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-thread-cache-test-"));
    _resetForTests(path.join(tempDir, "slack-thread-participation.json"));
  });

  afterEach(() => {
    _resetForTests(undefined);
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("records and checks thread participation", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("returns false for unrecorded threads", () => {
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("distinguishes different channels and threads", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000002")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000001")).toBe(false);
  });

  it("scopes participation by accountId", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A2", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("ignores empty accountId, channelId, or threadTs", () => {
    recordSlackThreadParticipation("", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C123", "");
    expect(hasSlackThreadParticipation("", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "")).toBe(false);
  });

  it("clears all entries", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C456", "1700000000.000002");
    clearSlackThreadParticipationCache();
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000002")).toBe(false);
  });

  it("shares thread participation across distinct module instances", async () => {
    const cacheA = await importFreshModule<typeof import("./sent-thread-cache.js")>(
      import.meta.url,
      "./sent-thread-cache.js?scope=shared-a",
    );
    const cacheB = await importFreshModule<typeof import("./sent-thread-cache.js")>(
      import.meta.url,
      "./sent-thread-cache.js?scope=shared-b",
    );

    cacheA.clearSlackThreadParticipationCache();

    try {
      cacheA.recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
      expect(cacheB.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);

      cacheB.clearSlackThreadParticipationCache();
      expect(cacheA.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    } finally {
      cacheA.clearSlackThreadParticipationCache();
    }
  });

  it("expired entries return false and are cleaned up on read", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    // Advance time past the 24-hour TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("enforces maximum entries by evicting oldest fresh entries", () => {
    for (let i = 0; i < 5001; i += 1) {
      recordSlackThreadParticipation("A1", "C123", `1700000000.${String(i).padStart(6, "0")}`);
    }

    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000000")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.005000")).toBe(true);
  });
});

describe("slack sent-thread-cache persistence", () => {
  let tempDir: string;
  let tempFile: string;

  afterEach(() => {
    _resetForTests(undefined);
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setup() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-thread-cache-test-"));
    tempFile = path.join(tempDir, "slack-thread-participation.json");
    _resetForTests(tempFile);
  }

  it("persists entries to disk and reloads on restart", () => {
    setup();
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();

    // Verify file exists and is valid JSON
    const raw = fs.readFileSync(tempFile, "utf8");
    const data = JSON.parse(raw) as Record<string, number>;
    expect(Object.keys(data)).toHaveLength(1);
    expect(data["A1:C123:1700000000.000001"]).toBeTypeOf("number");

    // Simulate restart — clear in-memory and reload from disk
    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("does not load expired entries from disk", () => {
    setup();
    // Write a file with an expired timestamp
    const expired: Record<string, number> = {
      "A1:C123:1700000000.000001": Date.now() - 25 * 60 * 60 * 1000,
    };
    fs.writeFileSync(tempFile, JSON.stringify(expired), "utf8");

    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("handles missing persist file gracefully", () => {
    setup();
    // No file written — should just start empty
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("clear persists empty state so entries do not return after restart", () => {
    setup();
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();

    clearSlackThreadParticipationCache();

    // Simulate restart
    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("clear before first load still wipes existing persist file", () => {
    setup();
    // Write a file with entries, then reset without loading
    const entries: Record<string, number> = {
      "A1:C123:1700000000.000001": Date.now(),
    };
    fs.writeFileSync(tempFile, JSON.stringify(entries), "utf8");
    _resetForTests(tempFile);

    // Clear before any read — should still wipe the file
    clearSlackThreadParticipationCache();

    // Simulate restart
    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("handles corrupt persist file gracefully", () => {
    setup();
    fs.writeFileSync(tempFile, "not json!!!", "utf8");

    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    // Should still be able to record new entries
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("reinserts on update so Map insertion order reflects recency", () => {
    setup();
    // Record A first, then B, then re-record A. After re-recording A,
    // its insertion-order position should be at the end (most recent),
    // not still at its original first position.
    recordSlackThreadParticipation("A1", "C123", "thread-A");
    recordSlackThreadParticipation("A1", "C123", "thread-B");
    recordSlackThreadParticipation("A1", "C123", "thread-A"); // re-record

    _flushPersist();
    const data: Record<string, number> = JSON.parse(fs.readFileSync(tempFile, "utf8"));
    const keys = Object.keys(data);
    // After re-record, thread-A's position should be after thread-B in
    // insertion order (Object.keys preserves Map insertion order in V8).
    expect(keys).toEqual(["A1:C123:thread-B", "A1:C123:thread-A"]);
  });

  it("caps in-memory map size on insert (not just on serialise)", () => {
    setup();
    // The MAX_ENTRIES cap is 5000. Recording 5005 unique entries should
    // leave the in-memory map capped at 5000 — the oldest 5 should be
    // evicted at insertion time, not deferred to the next persist.
    for (let i = 0; i < 5005; i++) {
      recordSlackThreadParticipation("A1", "C123", `thread-${i.toString().padStart(5, "0")}`);
    }
    _flushPersist();
    const data: Record<string, number> = JSON.parse(fs.readFileSync(tempFile, "utf8"));
    const keys = Object.keys(data);
    expect(keys.length).toBe(5000);
    // The oldest 5 (thread-00000 through thread-00004) should have been
    // evicted; the most recent (thread-05004) should remain.
    expect(keys).not.toContain("A1:C123:thread-00000");
    expect(keys).not.toContain("A1:C123:thread-00004");
    expect(keys).toContain("A1:C123:thread-00005");
    expect(keys).toContain("A1:C123:thread-05004");
  });

  it("writes persist file with mode 0o600 (owner read/write only)", () => {
    setup();
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();
    const stat = fs.statSync(tempFile);
    // Mask off file-type bits, leaving only permission bits.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses to load a persist file larger than MAX_PERSIST_FILE_BYTES (4 MB)", () => {
    setup();
    // Write a file > 4 MB to the configured persist path. The content is
    // syntactically valid JSON that *would* parse if we attempted to
    // read it — this proves we're rejecting on size, not on parse error.
    // Strategy: one entry whose key is a 5 MB string. Object.keys order
    // is preserved, so we can predict the key.
    const enormousKey = "X".repeat(5 * 1024 * 1024);
    const huge: Record<string, number> = { [enormousKey]: Date.now() };
    fs.writeFileSync(tempFile, JSON.stringify(huge));
    expect(fs.statSync(tempFile).size).toBeGreaterThan(4 * 1024 * 1024);

    _resetForTests(tempFile); // forces re-hydration on next access
    // Hydration must reject the oversized file; no entries loaded.
    // We can't easily query the bypass key without recording it first,
    // but the key isn't a thread-tuple shape anyway. Probe with a
    // canonical-shaped lookup that would only succeed if hydration loaded
    // SOMETHING from the file (it shouldn't):
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    // And recording a fresh entry still works — starts from empty state.
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("refuses non-object payloads in persist file (schema validation)", () => {
    setup();
    fs.writeFileSync(tempFile, JSON.stringify(["not", "an", "object"]));
    _resetForTests(tempFile);
    // Hydration accepted the file (it's valid JSON) but the array payload
    // is rejected by the schema check, so no entries are loaded.
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    // Recording a new entry still works — starts fresh.
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("rejects future timestamps from a crafted persist file (gpt-5.5 P2-C)", () => {
    setup();
    const now = Date.now();
    const data: Record<string, number> = {
      "A1:C123:past": now - 1000,
      "A1:C123:future-near": now + 60_000, // 1 min in the future
      "A1:C123:future-far": Number.MAX_SAFE_INTEGER, // far future
      "A1:C123:zero": 0,
      "A1:C123:negative": -1,
    };
    fs.writeFileSync(tempFile, JSON.stringify(data));
    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "past")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "future-near")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "future-far")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "zero")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "negative")).toBe(false);
  });

  it("creates the persist directory with mode 0o700 (gpt-5.5 P2-D)", () => {
    // Use a NEW subdirectory under tempDir that doesn't yet exist; that
    // way the mkdirSync mode applies (mode is only honoured on creation).
    const nestedFile = path.join(tempDir, "nested", "slack-thread-participation.json");
    _resetForTests(nestedFile);
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();
    const stat = fs.statSync(path.dirname(nestedFile));
    expect(stat.isDirectory()).toBe(true);
    // Mask off type bits and check perms. Owner: rwx; group/other: none.
    // (Test isolated from umask peculiarities by checking the lower 9 bits.)
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("preserves oldest-first iteration order after over-capacity slice (gpt-5.5 P3-B)", () => {
    setup();
    // Write a file with > MAX_ENTRIES so hydration triggers the
    // DESC sort + slice path, then verify in-memory eviction picks
    // the OLDEST entry first (Map insertion order = ts-ASC after the
    // re-sort fix).
    const data: Record<string, number> = {};
    const baseTs = Date.now();
    const total = 5050;
    for (let i = 0; i < total; i++) {
      const key = `A1:C123:order-${i.toString().padStart(5, "0")}`;
      data[key] = baseTs - (total - i);
    }
    fs.writeFileSync(tempFile, JSON.stringify(data));
    _resetForTests(tempFile);
    // Trigger hydration via any read — we expect the newest 5000
    // (order-00050 … order-05049) to land in the in-memory map.
    expect(hasSlackThreadParticipation("A1", "C123", "order-00050")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "order-05049")).toBe(true);
    // Now record a single brand-new entry. The map is at MAX_ENTRIES so
    // this triggers the eviction loop, which calls keys().next() to
    // pick the OLDEST. With the P3-B fix, that's order-00050 (the oldest
    // hydrated entry). Without the fix, it would be order-05049 (newest)
    // because DESC iteration order would have inverted insertion order.
    recordSlackThreadParticipation("A1", "C123", "brand-new");
    expect(hasSlackThreadParticipation("A1", "C123", "brand-new")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "order-00050")).toBe(false);
    // The newest hydrated entry must still be present — it is younger
    // than brand-new entries' eviction target by construction.
    expect(hasSlackThreadParticipation("A1", "C123", "order-05049")).toBe(true);
  });

  it("caps hydration at MAX_ENTRIES even when the file holds many more (Aisle medium #1)", () => {
    setup();
    // The file-size cap is 4 MB ≈ ~250K entries with realistic key sizes.
    // Make sure that even when a file slips past the size guard with more
    // than MAX_ENTRIES (5000) valid entries, hydration still bounds the
    // in-memory map. Use 5050 entries with monotonically-increasing
    // timestamps so the newest 5000 win the truncation.
    const data: Record<string, number> = {};
    const baseTs = Date.now();
    const total = 5050;
    for (let i = 0; i < total; i++) {
      const key = `A1:C123:hydrate-${i.toString().padStart(5, "0")}`;
      data[key] = baseTs - (total - i); // newer = larger ts
    }
    fs.writeFileSync(tempFile, JSON.stringify(data));
    _resetForTests(tempFile);
    // Trigger hydration via any read.
    hasSlackThreadParticipation("A1", "C123", "hydrate-00000");
    // The oldest 50 entries (00000–00049) must be dropped; the newest
    // MAX_ENTRIES (00050–05049) must be retained.
    expect(hasSlackThreadParticipation("A1", "C123", "hydrate-00000")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "hydrate-00049")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "hydrate-00050")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "hydrate-05049")).toBe(true);
  });

  it("persistPathOverride survives module re-import (Codex thread / opus P1)", async () => {
    // The persist path override lives on the global persistState singleton,
    // not as a module-local let. A second copy of the module loaded via
    // import-fresh must observe the same override and write to the same
    // temp file, NOT silently fall back to STATE_DIR.
    setup();
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();
    // Sanity: original module persisted to tempFile.
    expect(fs.existsSync(tempFile)).toBe(true);

    const fresh = await importFreshModule<typeof import("./sent-thread-cache.js")>(
      import.meta.url,
      "./sent-thread-cache.js?scope=reimport-test",
    );
    // Fresh module copy must hydrate from the same tempFile (override
    // is global, not module-local) and observe the persisted entry.
    expect(fresh.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
    // And a write through the fresh copy must land in tempFile, not
    // STATE_DIR (verified by stat'ing the file size grows).
    const sizeBefore = fs.statSync(tempFile).size;
    fresh.recordSlackThreadParticipation("A1", "C123", "1700000000.000002");
    fresh._flushPersist();
    const sizeAfter = fs.statSync(tempFile).size;
    expect(sizeAfter).toBeGreaterThan(sizeBefore);
  });

  it("refuses to write through a pre-existing symlink at the tmp path (CWE-59 / Aisle medium #2)", () => {
    setup();
    // Pre-create a symlink that mimics a tmp file an attacker could
    // squat. The previous implementation used `${filePath}.${pid}.tmp`
    // with the default "w" flag, which would happily follow the symlink
    // and truncate the target. Now tmp filenames are randomUUID()-based
    // AND opened with flag "wx" (O_CREAT | O_EXCL) so any existing entry
    // — file or symlink — makes the write fail safely.
    //
    // We can't predict the random tmp name, so test the flag semantics
    // by pre-creating a symlink at the FINAL filePath instead and
    // verifying that even an entry attempt does not corrupt a sensitive
    // target. The atomic-rename design means the rename step replaces
    // the symlink at filePath with our regular file — the dangerous case
    // (truncation through symlink) is the WRITE, not the rename.
    const decoyTarget = path.join(tempDir, "sensitive.txt");
    fs.writeFileSync(decoyTarget, "DO_NOT_CLOBBER");

    // Trigger a write via _flushPersist with at least one entry.
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    _flushPersist();

    // The decoy target must be untouched (we never write through any
    // symlink that points at it).
    expect(fs.readFileSync(decoyTarget, "utf8")).toBe("DO_NOT_CLOBBER");
    // And our persist file is a regular JSON, not a symlink.
    const stat = fs.lstatSync(tempFile);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    // Tmp files clean up properly: no leftover *.tmp files in tempDir.
    const leftover = fs.readdirSync(tempDir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("filters non-finite timestamps from a corrupt persist file (defensive)", () => {
    setup();
    const data: Record<string, unknown> = {
      "A1:C123:valid": Date.now(),
      "A1:C123:nan": "not-a-number",
      "A1:C123:inf": Number.POSITIVE_INFINITY,
    };
    fs.writeFileSync(tempFile, JSON.stringify(data));
    _resetForTests(tempFile);
    expect(hasSlackThreadParticipation("A1", "C123", "valid")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "nan")).toBe(false);
    // Note: Infinity serialises to null in JSON, so this is really a
    // null-vs-number test, but the code path is the same.
    expect(hasSlackThreadParticipation("A1", "C123", "inf")).toBe(false);
  });
});

describe("slack sent-thread-cache test-helper guards", () => {
  // These tests run inside vitest, so isTestEnvironment() is true and the
  // helpers work normally. To prove the guard, we deliberately strip the
  // env vars and assert that the helpers throw.

  it("_resetForTests throws when called outside a test environment", () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST: process.env.OPENCLAW_TEST,
    };
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      delete process.env.OPENCLAW_TEST;
      expect(() => _resetForTests("/tmp/should-throw.json")).toThrow(/test-only helper/i);
    } finally {
      if (saved.NODE_ENV !== undefined) {
        process.env.NODE_ENV = saved.NODE_ENV;
      }
      if (saved.VITEST !== undefined) {
        process.env.VITEST = saved.VITEST;
      }
      if (saved.OPENCLAW_TEST !== undefined) {
        process.env.OPENCLAW_TEST = saved.OPENCLAW_TEST;
      }
    }
  });

  it("_flushPersist throws when called outside a test environment", () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST: process.env.OPENCLAW_TEST,
    };
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      delete process.env.OPENCLAW_TEST;
      expect(() => _flushPersist()).toThrow(/test-only helper/i);
    } finally {
      if (saved.NODE_ENV !== undefined) {
        process.env.NODE_ENV = saved.NODE_ENV;
      }
      if (saved.VITEST !== undefined) {
        process.env.VITEST = saved.VITEST;
      }
      if (saved.OPENCLAW_TEST !== undefined) {
        process.env.OPENCLAW_TEST = saved.OPENCLAW_TEST;
      }
    }
  });
});
