// Regression test for the recall-store overflow eviction bug (openclaw/openclaw#150635):
// when the short-term recall store hits its 512-entry cap, nightly staging rows stamped
// with the sweep time used to outrank entries that carry real interactive-recall
// evidence, so the only promotable entry was evicted and the deep promotion phase
// found zero candidates. The retention comparator must keep recall-evidence entries.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStore } from "./short-term-promotion-store.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
} from "./short-term-promotion-types.js";
import { SHORT_TERM_RECALL_MAX_ENTRIES } from "./short-term-promotion-utils.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

const MEMORY_PATH = "memory/2026-10-01.md";
const SNIPPET = "Marta keeps the spare key under the blue flowerpot.";
const RECALL_DAYS = [
  "2026-09-27T09:00:00.000Z",
  "2026-09-28T09:00:00.000Z",
  "2026-09-29T09:00:00.000Z",
  "2026-09-30T09:00:00.000Z",
  "2026-10-01T09:00:00.000Z",
];
const RECALL_QUERIES = [
  "where is the spare key",
  "spare key location",
  "blue flowerpot key",
  "marta spare key",
  "key hiding spot",
];
const SWEEP_AT = "2026-10-02T04:00:00.000Z";

async function seedWorkspace(workspaceDir: string) {
  const notePath = path.join(workspaceDir, MEMORY_PATH);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, `${SNIPPET}\n`, "utf8");
}

function recalledResult() {
  return {
    path: MEMORY_PATH,
    startLine: 1,
    endLine: 1,
    score: 1,
    snippet: SNIPPET,
    source: "memory" as const,
  };
}

function stagedResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: "memory/2026-10-02.md",
    startLine: index + 1,
    endLine: index + 1,
    score: 0.58,
    snippet: `Nightly staged line ${index + 1}.`,
    source: "memory" as const,
  }));
}

describe("recall store overflow keeps recall-evidence entries (regression)", () => {
  it("does not evict the only promotable entry when nightly staging overflows the store, and the deep phase still finds it", async () => {
    const workspaceDir = await createTempWorkspace("recall-overflow-regression-");
    await seedWorkspace(workspaceDir);

    // Five interactive recalls across five days: the only row with recall evidence.
    for (const [index, now] of RECALL_DAYS.entries()) {
      await recordShortTermRecalls({
        workspaceDir,
        query: RECALL_QUERIES[index]!,
        nowMs: Date.parse(now),
        results: [recalledResult()],
      });
    }

    // Nightly ingestion then stages SHORT_TERM_RECALL_MAX_ENTRIES rows at sweep time,
    // pushing the store to 513 entries so retention must evict exactly one row.
    await recordShortTermRecalls({
      workspaceDir,
      query: "nightly session ingestion sweep",
      signalType: "daily",
      nowMs: Date.parse(SWEEP_AT),
      results: stagedResults(SHORT_TERM_RECALL_MAX_ENTRIES),
    });

    const store = await readStore(workspaceDir, SWEEP_AT);
    const entries = Object.values(store.entries);
    expect(entries).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);

    // The recalled entry survived the overflow; only staging-only rows were dropped.
    const recalled = entries.filter((entry) => entry.recallCount > 0);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.path).toBe(MEMORY_PATH);
    expect(recalled[0]?.userQueryHashes).toHaveLength(RECALL_QUERIES.length);

    // Deep promotion phase: with the shipped thresholds, the surviving entry must
    // still rank as a candidate instead of the phase finding zero candidates.
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: DEFAULT_PROMOTION_MIN_SCORE,
      minRecallCount: DEFAULT_PROMOTION_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
      nowMs: Date.parse(SWEEP_AT),
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.path).toBe(MEMORY_PATH);
    expect(candidates[0]?.uniqueQueries).toBe(RECALL_QUERIES.length);
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(DEFAULT_PROMOTION_MIN_SCORE);
  });
});
