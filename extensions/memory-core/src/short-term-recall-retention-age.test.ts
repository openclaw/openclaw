// Memory Core covers the retention age gate: a recalled row that the promotion
// ranker would reject for age must not hold a protected slot ahead of
// staging-only rows.
import { describe, expect, it } from "vitest";
import type { ShortTermRecallEntry, ShortTermRecallStore } from "./short-term-promotion-types.js";
import {
  enforceShortTermRecallStoreRetention,
  SHORT_TERM_RECALL_MAX_ENTRIES,
} from "./short-term-promotion-utils.js";

const NOW_MS = Date.parse("2026-11-16T03:00:00.000Z");
const STAGED_AT = "2026-11-16T03:00:00.000Z";
const FRESH_RECALL_AT = "2026-11-15T10:00:00.000Z";
const OLD_RECALL_AT = "2026-09-01T10:00:00.000Z";

function stagedEntry(key: string): ShortTermRecallEntry {
  return {
    key,
    path: "memory/2026-11-16.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: "Staged note " + key + ".",
    recallCount: 0,
    dailyCount: 1,
    groundedCount: 0,
    totalScore: 0.58,
    maxScore: 0.58,
    firstRecalledAt: STAGED_AT,
    lastRecalledAt: STAGED_AT,
    queryHashes: [],
    userQueryHashes: [],
    recallDays: [],
    conceptTags: [],
  };
}

// A row that carries interactive recall evidence.
function recalledEntry(key: string, lastRecalledAt: string): ShortTermRecallEntry {
  const queryHashes = ["q-" + key + "-1", "q-" + key + "-2", "q-" + key + "-3"];
  return {
    key,
    path: "memory/2026-11-15.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: "Recalled claim " + key + ".",
    recallCount: 3,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 3,
    maxScore: 0.91,
    firstRecalledAt: lastRecalledAt,
    lastRecalledAt,
    queryHashes,
    userQueryHashes: queryHashes,
    recallDays: ["2026-11-15"],
    conceptTags: [],
  };
}

function buildStore(lastRecalledAt: string): ShortTermRecallStore {
  const entries: Record<string, ShortTermRecallEntry> = {};
  for (let index = 0; index < SHORT_TERM_RECALL_MAX_ENTRIES; index += 1) {
    entries["staged-" + index] = stagedEntry("staged-" + index);
  }
  entries["recalled"] = recalledEntry("recalled", lastRecalledAt);
  return { version: 1, updatedAt: STAGED_AT, entries };
}

describe("short-term recall retention age gate", () => {
  it("keeps a recall-evidenced row inside the default age window", () => {
    const store = buildStore(FRESH_RECALL_AT);
    const removed = enforceShortTermRecallStoreRetention(store, { nowMs: NOW_MS });
    expect(removed).toBe(1);
    expect(store.entries["recalled"]).toBeDefined();
  });

  it("does not protect a recall-evidenced row past the default age ceiling", () => {
    const store = buildStore(OLD_RECALL_AT);
    const removed = enforceShortTermRecallStoreRetention(store, { nowMs: NOW_MS });
    expect(removed).toBe(1);
    expect(store.entries["recalled"]).toBeUndefined();
  });

  it("keeps a recall-evidenced row inside an explicitly wider age window", () => {
    const store = buildStore(OLD_RECALL_AT);
    const removed = enforceShortTermRecallStoreRetention(store, {
      nowMs: NOW_MS,
      maxAgeDays: 90,
    });
    expect(removed).toBe(1);
    expect(store.entries["recalled"]).toBeDefined();
  });

  it("honours an explicitly unlimited age window", () => {
    const store = buildStore(OLD_RECALL_AT);
    const removed = enforceShortTermRecallStoreRetention(store, {
      nowMs: NOW_MS,
      maxAgeDays: -1,
    });
    expect(removed).toBe(1);
    expect(store.entries["recalled"]).toBeDefined();
  });
});
