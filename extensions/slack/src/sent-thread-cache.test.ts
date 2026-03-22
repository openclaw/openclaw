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
});
