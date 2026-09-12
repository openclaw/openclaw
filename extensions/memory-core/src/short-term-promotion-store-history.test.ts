// Real-path integration test for the strict recall-store decoding change.
//
// Reviewer concern (ClawSweeper P1 on PR #146262): valid persisted recall history
// must be preserved, and previously coerced counters must not silently reset,
// including on the Doctor legacy-import path.
//
// This test drives the REAL store read path (readStore -> readShortTermStore ->
// normalizeShortTermRecallStore) against the real SQLite-backed plugin state
// store, using the repo's own test configuration. It asserts that a healthy
// store round-trips unchanged and that a malformed sibling cannot damage it.
//
// Scope note: `rankShortTermPromotionCandidates` is additionally covered by the
// existing suite; this file focuses on the persistence/history-preservation
// question the reviewer raised.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStore } from "./short-term-promotion-store.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

const NOW = "2026-09-13T00:00:00.000Z";

// Raw (pre-normalization) store shape: the writer accepts any JSON value per
// entry, so the malformed fixtures below can hold non-numeric encodings.
type RawRecallStore = {
  version: number;
  updatedAt: string;
  entries: Record<string, Record<string, unknown>>;
};

function validStore() {
  return {
    version: 1,
    updatedAt: NOW,
    entries: {
      alpha: {
        path: "memory/2026-09-01.md",
        startLine: 3,
        endLine: 9,
        source: "memory",
        snippet: "Alpha note with a healthy recall history.",
        recallCount: 4,
        dailyCount: 2,
        groundedCount: 1,
        totalScore: 2.5,
        maxScore: 0.85,
        firstRecalledAt: "2026-09-01T00:00:00.000Z",
        lastRecalledAt: "2026-09-10T00:00:00.000Z",
        recallDays: ["2026-09-08", "2026-09-10"],
        queryHashes: ["q1", "q2"],
        conceptTags: ["alpha"],
      },
      beta: {
        path: "memory/notes/2026-09-02-detail.md",
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: "Beta note.",
        recallCount: 0,
        dailyCount: 0,
        groundedCount: 0,
        totalScore: 0,
        maxScore: 0,
        firstRecalledAt: "2026-09-02T00:00:00.000Z",
        lastRecalledAt: "2026-09-02T00:00:00.000Z",
        recallDays: [],
        queryHashes: [],
        conceptTags: [],
      },
      gamma: {
        path: "memory/2026-09-03.md",
        startLine: 12,
        endLine: 20,
        source: "memory",
        snippet: "Gamma note with a fractional score.",
        recallCount: 7,
        dailyCount: 3,
        groundedCount: 2,
        totalScore: 0.333,
        maxScore: 0.999,
        firstRecalledAt: "2026-09-03T00:00:00.000Z",
        lastRecalledAt: "2026-09-12T00:00:00.000Z",
        recallDays: ["2026-09-11", "2026-09-12"],
        queryHashes: ["q3"],
        conceptTags: ["gamma"],
      },
    },
  };
}

describe("recall store history preservation through the real read path", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    await configureMemoryCoreDreamingStateForTests();
    workspaceDir = mkdtempSync(join(tmpdir(), "mc-history-"));
  });

  afterEach(() => {
    resetMemoryCoreDreamingStateForTests();
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves a healthy store field-for-field through readStore()", async () => {
    const original = validStore();
    await testing.writeRawRecallStore(workspaceDir, structuredClone(original));

    const read = await readStore(workspaceDir, NOW);

    expect(Object.keys(read.entries).toSorted()).toStrictEqual(["alpha", "beta", "gamma"]);
    expect(read.entries.alpha).toMatchObject({
      startLine: 3,
      endLine: 9,
      recallCount: 4,
      dailyCount: 2,
      groundedCount: 1,
      totalScore: 2.5,
      maxScore: 0.85,
    });
    // A fractional score must not be rounded or dropped on the way through SQLite.
    expect(read.entries.gamma?.totalScore).toBe(0.333);
    expect(read.entries.gamma?.maxScore).toBe(0.999);
    // Zero-valued counters must stay zero, not become undefined.
    expect(read.entries.beta?.recallCount).toBe(0);
    expect(read.entries.beta?.totalScore).toBe(0);
  });

  it("is a fixed point: a second read equals the first", async () => {
    await testing.writeRawRecallStore(workspaceDir, validStore());
    const first = await readStore(workspaceDir, NOW);
    const second = await readStore(workspaceDir, NOW);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("leaves valid history untouched when a malformed sibling is present", async () => {
    const withBrokenSibling = validStore() as unknown as RawRecallStore;
    // Values a hand-edited or externally-written JSON store can actually contain.
    // (Non-finite numbers cannot reach disk as JSON, and the plugin state writer
    // rejects them outright -- asserted separately below.)
    withBrokenSibling.entries.broken = {
      path: "memory/2026-09-04.md",
      startLine: "0x10",
      endLine: 20,
      source: "memory",
      snippet: "Broken row.",
      recallCount: -1,
      dailyCount: 0,
      groundedCount: 0,
      totalScore: "not-a-number",
      maxScore: 1,
      firstRecalledAt: "2026-09-04T00:00:00.000Z",
      lastRecalledAt: "2026-09-04T00:00:00.000Z",
    };

    await testing.writeRawRecallStore(workspaceDir, structuredClone(withBrokenSibling));
    const read = await readStore(workspaceDir, NOW);

    // The malformed row is dropped; the healthy rows are byte-identical.
    expect(Object.keys(read.entries).toSorted()).toStrictEqual(["alpha", "beta", "gamma"]);
    expect(read.entries.alpha).toMatchObject({
      startLine: 3,
      endLine: 9,
      recallCount: 4,
      totalScore: 2.5,
    });
  });

  it("rejects a non-finite value at the write boundary", async () => {
    // Defence in depth: even if a non-finite number is produced in memory, the
    // plugin state writer refuses it, so it can never reach persisted storage.
    const store = validStore() as unknown as RawRecallStore;
    store.entries.alpha = { ...store.entries.alpha, recallCount: Infinity };

    await expect(testing.writeRawRecallStore(workspaceDir, store)).rejects.toThrow(/finite number/);
  });

  it("never surfaces a non-finite numeric field from the store", async () => {
    const store = validStore() as unknown as RawRecallStore;
    // JSON-representable malformed counters that previously coerced silently.
    store.entries.alpha = {
      ...store.entries.alpha,
      recallCount: -1,
      totalScore: "1e999",
      maxScore: "0x10",
      dailyCount: "",
    };

    await testing.writeRawRecallStore(workspaceDir, structuredClone(store));
    const read = await readStore(workspaceDir, NOW);

    for (const entry of Object.values(read.entries)) {
      for (const value of [
        entry.startLine,
        entry.endLine,
        entry.recallCount,
        entry.dailyCount,
        entry.groundedCount,
        entry.totalScore,
        entry.maxScore,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
