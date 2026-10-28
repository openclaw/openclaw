import { describe, expect, it } from "vitest";
import type { ShortTermRecallEntry, ShortTermRecallStore } from "./short-term-promotion-types.js";
import {
  SHORT_TERM_RECALL_MAX_ENTRIES,
  enforceShortTermRecallStoreRetention,
} from "./short-term-promotion-utils.js";

function recallEntry(
  overrides: Partial<ShortTermRecallEntry> & { key: string },
): ShortTermRecallEntry {
  return {
    path: "memory/2026-10-01.md",
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: "Joe plays on the GREEN hockey team.",
    recallCount: 0,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 0,
    maxScore: 0,
    firstRecalledAt: "2026-10-01T00:00:00.000Z",
    lastRecalledAt: "2026-10-01T00:00:00.000Z",
    queryHashes: [],
    recallDays: [],
    conceptTags: [],
    ...overrides,
  };
}

function recallStore(entries: ShortTermRecallEntry[]): ShortTermRecallStore {
  return {
    version: 1,
    updatedAt: "2026-10-02T03:00:00.000Z",
    entries: Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  };
}

describe("short-term recall store retention", () => {
  it("keeps recall-bearing entries when nightly staged entries overflow the store", () => {
    const recalled = Array.from({ length: 3 }, (_, index) =>
      recallEntry({
        key: `recalled-${index}`,
        recallCount: 5,
        totalScore: 4.5,
        maxScore: 0.95,
        lastRecalledAt: "2026-10-01T10:49:00.000Z",
        queryHashes: [`query-${index}`],
        userQueryHashes: [`query-${index}`],
      }),
    );
    const staged = Array.from({ length: SHORT_TERM_RECALL_MAX_ENTRIES }, (_, index) =>
      recallEntry({
        key: `staged-${index}`,
        dailyCount: 1,
        totalScore: 0.58,
        maxScore: 0.58,
        lastRecalledAt: "2026-10-02T01:00:00.303Z",
      }),
    );
    const store = recallStore([...recalled, ...staged]);

    const removed = enforceShortTermRecallStoreRetention(store);

    expect(removed).toBe(3);
    expect(Object.keys(store.entries)).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    for (const entry of recalled) {
      expect(store.entries[entry.key]).toBeDefined();
    }
    expect(Object.values(store.entries).every((entry) => entry.recallCount > 0)).toBe(false);
  });

  it("evicts staged entries before recalled entries regardless of recency", () => {
    const recalled = recallEntry({
      key: "recalled",
      recallCount: 1,
      lastRecalledAt: "2026-10-01T10:49:00.000Z",
    });
    const staged = Array.from({ length: SHORT_TERM_RECALL_MAX_ENTRIES }, (_, index) =>
      recallEntry({
        key: `staged-${index}`,
        dailyCount: 1,
        lastRecalledAt: "2026-10-02T01:00:00.303Z",
      }),
    );
    const store = recallStore([recalled, ...staged]);

    const removed = enforceShortTermRecallStoreRetention(store);

    expect(removed).toBe(1);
    expect(store.entries.recalled).toBeDefined();
  });

  it("still evicts the oldest entries when every entry carries recall evidence", () => {
    const entries = Array.from({ length: SHORT_TERM_RECALL_MAX_ENTRIES + 3 }, (_, index) =>
      recallEntry({
        key: `recalled-${index}`,
        recallCount: 1,
        lastRecalledAt: new Date(
          Date.parse("2026-10-01T00:00:00.000Z") + index * 1000,
        ).toISOString(),
      }),
    );
    const store = recallStore(entries);

    const removed = enforceShortTermRecallStoreRetention(store);

    expect(removed).toBe(3);
    expect(store.entries["recalled-0"]).toBeUndefined();
    expect(store.entries["recalled-1"]).toBeUndefined();
    expect(store.entries["recalled-2"]).toBeUndefined();
    expect(store.entries[`recalled-${SHORT_TERM_RECALL_MAX_ENTRIES + 2}`]).toBeDefined();
  });
});
