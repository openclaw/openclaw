// Focused tests for the structural low-diversity recurrence observation.
// This observes signalCount >= minRecallCount AND uniqueQueries < minUniqueQueries.
// It establishes nothing about rumination, worry, or unresolved concerns.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeDeepDreamingReport } from "./dreaming-markdown.js";
import {
  countLowDiversityRecurrences,
  rankShortTermPromotionCandidates,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const NOW_ISO = "2026-04-04T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const { createTempWorkspace } = createMemoryCoreTestHarness();

function narrowEntry(
  params: Partial<ShortTermRecallEntry> & { key: string },
): ShortTermRecallEntry {
  return {
    path: "memory/2026-04-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `${params.key} narrowly recalled note`,
    recallCount: 3,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 2.4,
    maxScore: 0.8,
    firstRecalledAt: "2026-04-01T10:00:00.000Z",
    lastRecalledAt: NOW_ISO,
    queryHashes: ["q1"],
    userQueryHashes: ["q1"],
    recallDays: ["2026-04-01", "2026-04-02"],
    conceptTags: [],
    provenance: { originClass: "owner", sessionKind: "interactive", observedAt: NOW_MS },
    ...params,
  };
}

async function writeEntries(workspaceDir: string, entries: ShortTermRecallEntry[]): Promise<void> {
  await shortTermTestState.writeRawRecallStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries: Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  });
}

describe("countLowDiversityRecurrences", () => {
  it("returns 0 for an empty store", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-empty-");
    await writeEntries(workspaceDir, []);
    await expect(countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS })).resolves.toBe(0);
  });

  it("counts a high-signal low-diversity entry", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-one-");
    await writeEntries(workspaceDir, [narrowEntry({ key: "narrow" })]);
    await expect(countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS })).resolves.toBe(1);
  });

  it("ignores a sufficiently diverse entry", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-diverse-");
    await writeEntries(workspaceDir, [
      narrowEntry({
        key: "diverse",
        userQueryHashes: ["q1", "q2", "q3"],
        queryHashes: ["q1", "q2", "q3"],
      }),
    ]);
    await expect(countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS })).resolves.toBe(0);
  });

  it("ignores entries below the signal minimum", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-weak-");
    await writeEntries(workspaceDir, [
      narrowEntry({ key: "weak", recallCount: 1, totalScore: 0.8 }),
    ]);
    await expect(countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS })).resolves.toBe(0);
  });

  it("excludes promoted, blocked-origin, and contaminated entries", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-excluded-");
    await writeEntries(workspaceDir, [
      narrowEntry({ key: "promoted", promotedAt: NOW_ISO }),
      narrowEntry({
        key: "blocked",
        provenance: { originClass: "untrusted", sessionKind: "interactive", observedAt: NOW_MS },
      }),
      narrowEntry({
        key: "system",
        provenance: { originClass: "system", sessionKind: "unknown", observedAt: NOW_MS },
      }),
      narrowEntry({
        key: "contaminated",
        snippet: "Candidate: staged <!-- openclaw-memory-promotion:abc -->",
      }),
    ]);
    await expect(countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS })).resolves.toBe(0);
  });

  it("does not alter promotion eligibility for diverse candidates", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-eligibility-");
    await writeEntries(workspaceDir, [
      narrowEntry({ key: "narrow" }),
      narrowEntry({
        key: "diverse",
        snippet: "diverse durable note with broad cues",
        recallCount: 4,
        totalScore: 3.4,
        maxScore: 0.9,
        userQueryHashes: ["q1", "q2", "q3", "q4"],
        queryHashes: ["q1", "q2", "q3", "q4"],
        recallDays: ["2026-04-01", "2026-04-02", "2026-04-03"],
        conceptTags: ["deploy", "staging", "gateway"],
      }),
    ]);
    const recurrenceCount = await countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS });
    expect(recurrenceCount).toBe(1);
    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 3,
      minUniqueQueries: 3,
      nowMs: NOW_MS,
    });
    expect(ranked.map((candidate) => candidate.key)).toEqual(["diverse"]);
  });
});

describe("low-diversity recurrence deep report", () => {
  it("records the observation in DREAMS.md without touching MEMORY.md", async () => {
    const workspaceDir = await createTempWorkspace("lowdiversity-report-");
    await writeEntries(workspaceDir, [narrowEntry({ key: "narrow" })]);
    const recurrenceCount = await countLowDiversityRecurrences({ workspaceDir, nowMs: NOW_MS });
    const ranked = await rankShortTermPromotionCandidates({ workspaceDir, nowMs: NOW_MS });
    expect(recurrenceCount).toBe(1);
    expect(ranked).toHaveLength(0);

    const reportLines = [
      `- Ranked ${ranked.length} candidate(s) for durable promotion.`,
      `- Recurrence without diversity: ${recurrenceCount} candidate(s) (not promoted).`,
      "- Promoted 0 candidate(s) into MEMORY.md.",
    ];
    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: reportLines,
      hasContent: recurrenceCount > 0,
      nowMs: NOW_MS,
      storage: { mode: "separate", separateReports: false },
    });

    const dreams = await fs.readFile(`${workspaceDir}/DREAMS.md`, "utf-8");
    expect(dreams).toContain("Recurrence without diversity: 1 candidate(s)");
    await expect(fs.access(`${workspaceDir}/MEMORY.md`)).rejects.toThrow();
  });
});
