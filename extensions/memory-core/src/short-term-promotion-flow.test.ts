// Memory Core proves the shipped recall -> store -> rank -> promote chain, so
// the retention fix is verified through recorded evidence and the promotion
// ranker rather than through synthetic rows, and so stored data written
// before an upgrade still loads and still promotes.
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
import {
  applyShortTermPromotionsForTests,
  createMemoryCoreTestHarness,
  shortTermTestState as testing,
} from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

// The shipped deep-phase thresholds, unmodified. The proof has to clear them
// as configured rather than with relaxed thresholds.
const PROMOTION_THRESHOLDS = {
  minScore: DEFAULT_PROMOTION_MIN_SCORE,
  minRecallCount: DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  minUniqueQueries: DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
};

const MEMORY_PATH = "memory/2026-10-01.md";
const MEMORY_SNIPPET = "Joe plays on the GREEN hockey team.";
const RECALL_DAYS = [
  "2026-09-27T10:00:00.000Z",
  "2026-09-28T10:00:00.000Z",
  "2026-09-29T10:00:00.000Z",
  "2026-09-30T10:00:00.000Z",
  "2026-10-01T10:00:00.000Z",
];
const RECALL_QUERIES = [
  "green hockey team",
  "hockey team green",
  "joe hockey",
  "green hockey roster",
  "who plays hockey",
];
const STAGED_AT = "2026-10-02T03:00:00.000Z";
const LAST_RECALL_DAY: string = RECALL_DAYS[RECALL_DAYS.length - 1]!;

async function writeWorkspace(workspaceDir: string) {
  const notePath = path.join(workspaceDir, MEMORY_PATH);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, `${MEMORY_SNIPPET}\n`, "utf8");
  await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");
}

function stagedResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: "memory/2026-10-02.md",
    startLine: index + 1,
    endLine: index + 1,
    score: 0.58,
    snippet: `Staged note ${index}.`,
    source: "memory" as const,
  }));
}

describe("short-term recall store retention flow", () => {
  it("promotes a recalled memory to MEMORY.md after nightly staging overflows the store", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-flow-");
    await writeWorkspace(workspaceDir);

    // Interactive recalls across five days: the evidence the ranker scores.
    for (const [index, now] of RECALL_DAYS.entries()) {
      await recordShortTermRecalls({
        workspaceDir,
        query: RECALL_QUERIES[index]!,
        nowMs: Date.parse(now),
        results: [
          {
            path: MEMORY_PATH,
            startLine: 1,
            endLine: 1,
            score: 1,
            snippet: MEMORY_SNIPPET,
            source: "memory",
          },
        ],
      });
    }

    // The nightly ingestion then fills the store past its 512-entry cap.
    await recordShortTermRecalls({
      workspaceDir,
      query: "nightly session ingestion",
      signalType: "daily",
      nowMs: Date.parse(STAGED_AT),
      results: stagedResults(SHORT_TERM_RECALL_MAX_ENTRIES),
    });

    const store = await readStore(workspaceDir, STAGED_AT);
    const entries = Object.values(store.entries);
    expect(entries).toHaveLength(SHORT_TERM_RECALL_MAX_ENTRIES);
    const recalled = entries.filter((entry) => entry.recallCount > 0);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.userQueryHashes).toHaveLength(RECALL_QUERIES.length);
    expect(entries.filter((entry) => entry.dailyCount > 0)).toHaveLength(
      SHORT_TERM_RECALL_MAX_ENTRIES - 1,
    );

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      ...PROMOTION_THRESHOLDS,
      nowMs: Date.parse(STAGED_AT),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.path).toBe(MEMORY_PATH);
    expect(candidates[0]?.uniqueQueries).toBe(RECALL_QUERIES.length);
    // Cleared the shipped thresholds without relaxing them.
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(DEFAULT_PROMOTION_MIN_SCORE);

    const applied = await applyShortTermPromotionsForTests({
      workspaceDir,
      candidates,
      ...PROMOTION_THRESHOLDS,
      nowMs: Date.parse(STAGED_AT),
    });
    expect(applied.applied).toBe(1);

    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memory).toContain(MEMORY_SNIPPET);
  });

  it("still loads and promotes a stored row written before query provenance existed", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-legacy-");
    await writeWorkspace(workspaceDir);

    // Rows written before query provenance existed carry queryHashes only.
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: LAST_RECALL_DAY,
      entries: {
        "memory:memory/2026-10-01.md:1:1:legacy": {
          path: MEMORY_PATH,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: MEMORY_SNIPPET,
          recallCount: RECALL_QUERIES.length,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: RECALL_QUERIES.length,
          maxScore: 1,
          firstRecalledAt: RECALL_DAYS[0],
          lastRecalledAt: LAST_RECALL_DAY,
          queryHashes: RECALL_QUERIES.map((_, index) => `legacy-query-${index}`),
          recallDays: ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
          conceptTags: ["hockey", "team"],
        },
      },
    });

    const store = await readStore(workspaceDir, LAST_RECALL_DAY);
    const legacy = Object.values(store.entries);
    expect(legacy).toHaveLength(1);
    // Normalization restores the earned query diversity the ranker scores.
    expect(legacy[0]?.userQueryHashes).toHaveLength(RECALL_QUERIES.length);

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      ...PROMOTION_THRESHOLDS,
      nowMs: Date.parse(LAST_RECALL_DAY),
    });
    expect(candidates).toHaveLength(1);

    const applied = await applyShortTermPromotionsForTests({
      workspaceDir,
      candidates,
      ...PROMOTION_THRESHOLDS,
      nowMs: Date.parse(LAST_RECALL_DAY),
    });
    expect(applied.applied).toBe(1);
    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memory).toContain(MEMORY_SNIPPET);
  });

  it("loads a stored row that carries no earned query diversity without promoting it", async () => {
    const workspaceDir = await createTempWorkspace("recall-retention-legacy-mixed-");
    await writeWorkspace(workspaceDir);

    // A stored row that also carries ingestion signal has no query provenance,
    // so normalization leaves it unqualified: uniqueQueries stays 0 and the
    // ranker will not promote it. It still has to load rather than be dropped.
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: LAST_RECALL_DAY,
      entries: {
        "memory:memory/2026-10-01.md:1:1:legacy-mixed": {
          path: MEMORY_PATH,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: MEMORY_SNIPPET,
          recallCount: RECALL_QUERIES.length,
          dailyCount: 1,
          groundedCount: 0,
          totalScore: RECALL_QUERIES.length + 1,
          maxScore: 1,
          firstRecalledAt: RECALL_DAYS[0],
          lastRecalledAt: LAST_RECALL_DAY,
          queryHashes: RECALL_QUERIES.map((_, index) => `legacy-query-${index}`),
          recallDays: ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
          conceptTags: ["hockey", "team"],
        },
      },
    });

    const store = await readStore(workspaceDir, LAST_RECALL_DAY);
    const legacy = Object.values(store.entries);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.recallCount).toBe(RECALL_QUERIES.length);
    expect(legacy[0]?.userQueryHashes).toBeUndefined();

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      ...PROMOTION_THRESHOLDS,
      nowMs: Date.parse(LAST_RECALL_DAY),
    });
    expect(candidates).toHaveLength(0);
  });
});
