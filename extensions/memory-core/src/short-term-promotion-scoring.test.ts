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
const RECALL_DAYS = ["2026-04-01", "2026-04-02", "2026-04-03"];
const THREE_QUERY_HASHES = ["query-a", "query-b", "query-c"];

const { createTempWorkspace } = createMemoryCoreTestHarness();

type CalibrationClass = "genuine" | "filler" | "oneoff";

function createRecallEntry(params: {
  key: string;
  snippet?: string;
  signalCount: number;
  avgScore: number;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
}): ShortTermRecallEntry {
  return {
    key: params.key,
    path: "memory/2026-04-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: params.snippet ?? `${params.key} durable note`,
    recallCount: 0,
    dailyCount: params.signalCount,
    groundedCount: 0,
    totalScore: params.avgScore * params.signalCount,
    maxScore: params.avgScore,
    firstRecalledAt: "2026-04-01T10:00:00.000Z",
    lastRecalledAt: NOW_ISO,
    queryHashes: params.queryHashes,
    userQueryHashes: params.queryHashes,
    recallDays: params.recallDays,
    conceptTags: params.conceptTags,
  };
}

async function writeCalibrationStore(workspaceDir: string): Promise<void> {
  const entries = [
    createRecallEntry({
      key: "genuine-a",
      signalCount: 3,
      avgScore: 0.58,
      queryHashes: THREE_QUERY_HASHES,
      recallDays: RECALL_DAYS,
      conceptTags: ["backup", "backups", "glacier", "s3"],
    }),
    createRecallEntry({
      key: "genuine-b",
      signalCount: 3,
      avgScore: 0.6,
      queryHashes: THREE_QUERY_HASHES,
      recallDays: RECALL_DAYS,
      conceptTags: ["backup", "backups", "glacier", "s3"],
    }),
    createRecallEntry({
      key: "genuine-c",
      signalCount: 3,
      avgScore: 0.62,
      queryHashes: THREE_QUERY_HASHES,
      recallDays: RECALL_DAYS,
      conceptTags: ["backup", "glacier", "s3"],
    }),
    ...[0.2, 0.3, 0.4].map((avgScore, index) =>
      createRecallEntry({
        key: `filler-${index}`,
        snippet: "Routine heartbeat completed successfully.",
        signalCount: 3,
        avgScore,
        queryHashes: THREE_QUERY_HASHES,
        recallDays: RECALL_DAYS,
        conceptTags: [],
      }),
    ),
    ...[0.8, 0.9, 0.99].map((avgScore, index) =>
      createRecallEntry({
        key: `oneoff-${index}`,
        signalCount: 1,
        avgScore,
        queryHashes: ["query-a"],
        recallDays: ["2026-04-03"],
        conceptTags: ["novel", "signal", "single", "mention"].slice(0, index + 2),
      }),
    ),
  ];
  await shortTermTestState.writeRawRecallStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries: Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  });
  await shortTermTestState.writeRawPhaseSignalStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries: Object.fromEntries(
      entries
        .filter((entry) => entry.key.startsWith("genuine-"))
        .map((entry) => [
          entry.key,
          {
            key: entry.key,
            lightHits: 3,
            remHits: 3,
            lastLightAt: NOW_ISO,
            lastRemAt: NOW_ISO,
          },
        ]),
    ),
  });
}

function scoresForClass(
  candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>["candidates"],
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

    const measured = (
      await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: NOW_MS,
      })
    ).candidates;
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

    const promoted = (await rankShortTermPromotionCandidates({ workspaceDir, nowMs: NOW_MS }))
      .candidates;
    expect(promoted.map((candidate) => candidate.key).toSorted()).toEqual([
      "genuine-a",
      "genuine-b",
      "genuine-c",
    ]);
  });

  it("keeps sweep and direct promotion fallback defaults aligned", () => {
    const sweep = resolveMemoryDeepDreamingConfig({ pluginConfig: {} });
    expect({
      minScore: sweep.minScore,
      minRecallCount: sweep.minRecallCount,
      minUniqueQueries: sweep.minUniqueQueries,
    }).toEqual({
      minScore: DEFAULT_PROMOTION_MIN_SCORE,
      minRecallCount: DEFAULT_PROMOTION_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
    });
    expect({
      minScore: DEFAULT_PROMOTION_MIN_SCORE,
      minRecallCount: DEFAULT_PROMOTION_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
    }).toEqual({
      minScore: DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
      minRecallCount: DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
    });
  });

  it("keeps the minimum score boundary inclusive", async () => {
    const workspaceDir = await createTempWorkspace("promotion-score-boundary-");
    const boundary = createRecallEntry({
      key: "boundary",
      signalCount: 10,
      avgScore: 0,
      queryHashes: ["query-a", "query-b", "query-c", "query-d", "query-e"],
      recallDays: [],
      conceptTags: [],
    });
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: { boundary },
    });
    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0.54,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: NOW_MS,
      }).then((ranking) => ranking.candidates),
    ).resolves.toHaveLength(1);
    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0.540001,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: NOW_MS,
      }).then((ranking) => ranking.candidates),
    ).resolves.toHaveLength(0);
  });

  it("preserves unambiguous recall-only legacy query diversity", async () => {
    const workspaceDir = await createTempWorkspace("promotion-recall-only-upgrade-");
    const legacy = createRecallEntry({
      key: "legacy-recall-only",
      signalCount: 3,
      avgScore: 1,
      queryHashes: THREE_QUERY_HASHES,
      recallDays: RECALL_DAYS,
      conceptTags: ["backup", "glacier"],
    });
    legacy.recallCount = 3;
    legacy.dailyCount = 0;
    delete legacy.userQueryHashes;
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: { legacy },
    });

    const ranked = (
      await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 3,
        nowMs: NOW_MS,
      })
    ).candidates;

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.uniqueQueries).toBe(3);
  });

  it("counts every excluded entry once, under the first gate that drops it", async () => {
    const workspaceDir = await createTempWorkspace("promotion-exclusion-tally-");
    const entry = (key: string, overrides: Partial<ShortTermRecallEntry> = {}) => ({
      ...createRecallEntry({
        key,
        signalCount: 3,
        avgScore: 1,
        queryHashes: THREE_QUERY_HASHES,
        recallDays: RECALL_DAYS,
        conceptTags: ["backup", "glacier", "s3"],
      }),
      ...overrides,
    });
    const entries = [
      entry("passes"),
      // Untrusted origin also fails the signal gate; only the earlier gate counts.
      entry("origin", {
        dailyCount: 1,
        provenance: { originClass: "untrusted", sessionKind: "interactive", observedAt: NOW_MS },
      }),
      entry("already-promoted", { promotedAt: NOW_ISO }),
      entry("signal", { dailyCount: 1, totalScore: 1 }),
      entry("query", { userQueryHashes: ["query-a"] }),
      entry("age", { lastRecalledAt: "2026-03-01T10:00:00.000Z" }),
      entry("score", { totalScore: 0, maxScore: 0, conceptTags: [], recallDays: ["2026-04-03"] }),
    ];
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: Object.fromEntries(entries.map((value) => [value.key, value])),
    });

    const ranking = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0.5,
      minRecallCount: 2,
      minUniqueQueries: 2,
      maxAgeDays: 7,
      nowMs: NOW_MS,
    });

    expect(ranking.candidates.map((candidate) => candidate.key)).toEqual(["passes"]);
    expect(ranking.considered).toBe(entries.length);
    expect(
      Object.fromEntries(
        ranking.exclusions.map(({ key, reason, detail }) => [key, { reason, detail }]),
      ),
    ).toEqual({
      origin: { reason: "origin", detail: "untrusted" },
      "already-promoted": { reason: "already promoted", detail: NOW_ISO },
      signal: { reason: "signal threshold", detail: "1 < 2" },
      query: { reason: "query threshold", detail: "1 < 2" },
      age: { reason: "age threshold", detail: "33.0d > 7d" },
      score: { reason: "score threshold", detail: expect.stringMatching(/ < 0\.5$/) },
    });
  });

  it("fails closed for ambiguous mixed legacy query hashes", async () => {
    const workspaceDir = await createTempWorkspace("promotion-mixed-upgrade-");
    const legacy = createRecallEntry({
      key: "legacy-mixed",
      signalCount: 3,
      avgScore: 1,
      queryHashes: THREE_QUERY_HASHES,
      recallDays: RECALL_DAYS,
      conceptTags: ["backup", "glacier"],
    });
    legacy.recallCount = 1;
    legacy.dailyCount = 2;
    delete legacy.userQueryHashes;
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: { legacy },
    });

    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 1,
        nowMs: NOW_MS,
      }).then((ranking) => ranking.candidates),
    ).resolves.toHaveLength(0);
  });
});
