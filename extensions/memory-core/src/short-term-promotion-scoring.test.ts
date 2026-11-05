// Memory Core tests calibrate deterministic short-term promotion scoring.
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
} from "./short-term-promotion-types.js";
import {
  rankShortTermPromotionCandidates,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const NOW_ISO = "2026-04-03T10:01:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const THREE_QUERY_HASHES = ["query-a", "query-b", "query-c"];

const { createTempWorkspace } = createMemoryCoreTestHarness();

type CalibrationClass = "genuine" | "filler" | "oneoff";

function createRecallEntry(
  key: string,
  signalCount: number,
  avgScore: number,
  overrides: Partial<ShortTermRecallEntry> = {},
): ShortTermRecallEntry {
  return {
    key,
    path: "memory/2026-04-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `${key} durable note`,
    recallCount: 0,
    dailyCount: signalCount,
    groundedCount: 0,
    totalScore: avgScore * signalCount,
    maxScore: avgScore,
    firstRecalledAt: "2026-04-01T10:00:00.000Z",
    lastRecalledAt: NOW_ISO,
    queryHashes: THREE_QUERY_HASHES,
    userQueryHashes: overrides.queryHashes ?? THREE_QUERY_HASHES,
    recallDays: ["2026-04-01", "2026-04-02", "2026-04-03"],
    conceptTags: ["backup", "glacier"],
    ...overrides,
  };
}

function writeRecallEntries(workspaceDir: string, entries: Record<string, ShortTermRecallEntry>) {
  return shortTermTestState.writeRawRecallStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries,
  });
}

function rankCandidates(
  workspaceDir: string,
  options: Partial<Parameters<typeof rankShortTermPromotionCandidates>[0]> = {},
) {
  return rankShortTermPromotionCandidates({
    workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    nowMs: NOW_MS,
    ...options,
  });
}

async function writeCalibrationStore(workspaceDir: string): Promise<void> {
  const entries = [
    createRecallEntry("genuine-a", 3, 0.58, {
      conceptTags: ["backup", "backups", "glacier", "s3"],
    }),
    createRecallEntry("genuine-b", 3, 0.6, { conceptTags: ["backup", "backups", "glacier", "s3"] }),
    createRecallEntry("genuine-c", 3, 0.62, { conceptTags: ["backup", "glacier", "s3"] }),
    ...[0.2, 0.3, 0.4].map((avgScore, index) =>
      createRecallEntry(`filler-${index}`, 3, avgScore, {
        snippet: "Routine heartbeat completed successfully.",
        conceptTags: [],
      }),
    ),
    ...[0.8, 0.9, 0.99].map((avgScore, index) =>
      createRecallEntry(`oneoff-${index}`, 1, avgScore, {
        queryHashes: ["query-a"],
        recallDays: ["2026-04-03"],
        conceptTags: ["novel", "signal", "single", "mention"].slice(0, index + 2),
      }),
    ),
  ];
  await writeRecallEntries(
    workspaceDir,
    Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  );
  await shortTermTestState.writeRawPhaseSignalStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries: Object.fromEntries(
      entries
        .filter((entry) => entry.key.startsWith("genuine-"))
        .map((entry) => [
          entry.key,
          { key: entry.key, lightHits: 3, remHits: 3, lastLightAt: NOW_ISO, lastRemAt: NOW_ISO },
        ]),
    ),
  });
}

function scoresForClass(
  candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>,
  calibrationClass: CalibrationClass,
): number[] {
  return candidates
    .filter((candidate) => candidate.key.startsWith(`${calibrationClass}-`))
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((candidate) => Number(candidate.score.toFixed(6)));
}

describe("short-term promotion score calibration", () => {
  it("separates repeated durable facts from filler and high-signal one-offs", async () => {
    const workspaceDir = await createTempWorkspace("promotion-score-distribution-");
    await writeCalibrationStore(workspaceDir);

    const measured = await rankCandidates(workspaceDir);
    const distribution = {
      genuine: scoresForClass(measured, "genuine"),
      filler: scoresForClass(measured, "filler"),
      oneoff: scoresForClass(measured, "oneoff"),
    };

    expect(distribution).toEqual({
      genuine: [0.750014, 0.756014, 0.752014],
      filler: [0.489152, 0.519152, 0.549152],
      oneoff: [0.529376, 0.569376, 0.606376],
    });

    const promoted = await rankShortTermPromotionCandidates({ workspaceDir, nowMs: NOW_MS });
    expect(promoted.map((candidate) => candidate.key).toSorted()).toEqual([
      "genuine-a",
      "genuine-b",
      "genuine-c",
    ]);
  });

  it("keeps sweep and direct promotion fallback defaults aligned", () => {
    const sweep = resolveMemoryDeepDreamingConfig({ pluginConfig: {} });
    const direct = {
      minScore: DEFAULT_PROMOTION_MIN_SCORE,
      minRecallCount: DEFAULT_PROMOTION_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
    };
    expect(sweep).toMatchObject(direct);
    expect(direct).toEqual({
      minScore: DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
      minRecallCount: DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
    });
  });

  it("keeps the minimum score boundary inclusive", async () => {
    const workspaceDir = await createTempWorkspace("promotion-score-boundary-");
    const boundary = createRecallEntry("boundary", 10, 0, {
      queryHashes: ["query-a", "query-b", "query-c", "query-d", "query-e"],
      recallDays: [],
      conceptTags: [],
    });
    await writeRecallEntries(workspaceDir, { boundary });
    await expect(rankCandidates(workspaceDir, { minScore: 0.54 })).resolves.toHaveLength(1);
    await expect(rankCandidates(workspaceDir, { minScore: 0.540001 })).resolves.toHaveLength(0);
  });

  it.each([
    { name: "recall-only", recallCount: 3, dailyCount: 0, minUniqueQueries: 3, retained: 1 },
    { name: "mixed", recallCount: 1, dailyCount: 2, minUniqueQueries: 1, retained: 0 },
  ])("preserves only unambiguous $name legacy query diversity", async (entry) => {
    const workspaceDir = await createTempWorkspace("promotion-legacy-upgrade-");
    const legacy = createRecallEntry(`legacy-${entry.name}`, 3, 1, {
      recallCount: entry.recallCount,
      dailyCount: entry.dailyCount,
    });
    delete legacy.userQueryHashes;
    await writeRecallEntries(workspaceDir, { legacy });
    const ranked = await rankCandidates(workspaceDir, { minUniqueQueries: entry.minUniqueQueries });
    expect(ranked).toHaveLength(entry.retained);
    if (entry.retained) {
      expect(ranked[0]?.uniqueQueries).toBe(3);
    }
  });
});
