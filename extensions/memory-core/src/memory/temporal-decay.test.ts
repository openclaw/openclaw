import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { applyTemporalDecayToHybridResults, parseQueryDates } from "./temporal-decay.js";

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 1, 10);
const { createTempWorkspace } = createMemoryCoreTestHarness();
const selective = { path: "notes", pattern: "stable/**/*.md", evergreen: true };
const notePaths = ["notes/stable/topic.md", "notes/dated/topic.md"];
const dated = ["memory/2026-01-11.md"];
const memoryPolicy = { path: "memory", evergreen: true };
const sessions = ["sessions/main/note.jsonl"];
const sessionPolicy = { path: "sessions", evergreen: true };

it.each([
  [notePaths, 30, [1, 0.5], selective, "memory", undefined, false],
  [notePaths, 0, [1, 0.5], selective, "memory", 30, false],
  [["MEMORY.md"], 90, [1], undefined, "memory", 90, false],
  [dated, 90, [0.5], memoryPolicy, "memory", 90, false],
  [dated, 90, [0.5], memoryPolicy, "memory", 90, true],
  [sessions, 90, [1], sessionPolicy, "sessions", undefined, false],
  [sessions, 90, [0.5], sessionPolicy, "sessions", 30, false],
] as const)(
  "ranks %j with filesystem age %s and expected scores %j",
  async (files, age, expected, extraPath, source, indexedAge, absolute) => {
    const workspaceDir = await createTempWorkspace("openclaw-temporal-decay-");
    for (const file of files) {
      const filename = path.join(workspaceDir, file);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "memory\n");
      const mtime = new Date(NOW_MS - age * DAY_MS);
      await fs.utimes(filename, mtime, mtime);
    }
    const results = files.map((file) => ({
      path: absolute ? path.join(workspaceDir, file) : file,
      score: 1,
      source,
    }));
    const mtimes = new Map(
      results.map((entry) => [
        entry.path,
        indexedAge === undefined ? undefined : NOW_MS - indexedAge * DAY_MS,
      ]),
    );
    const ranked = await applyTemporalDecayToHybridResults({
      results,
      workspaceDir,
      extraPaths: extraPath ? [extraPath] : undefined,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
      memorySourceMtimes: source === "memory" && indexedAge !== undefined ? mtimes : undefined,
      sessionSourceMtimes: source === "sessions" ? mtimes : undefined,
    });
    for (const [index, score] of expected.entries()) {
      expect(ranked[index]?.score).toBeCloseTo(score, 2);
    }
  },
);

const NOV_2026_MS = Date.UTC(2026, 10, 26);


function scoreOf(entries: { path: string; score: number }[], filePath: string): number {
  return entries.find((entry) => entry.path === filePath)?.score ?? NaN;
}


it("parses ISO and written dates from a query", () => {
  expect([...parseQueryDates("rollup for 2026-11-16 and November 24, 2026")].sort()).toEqual([
    "2026-11-16",
    "2026-11-24",
  ]);
  expect(parseQueryDates("no dates here").size).toBe(0);
});

it.each([
  "HKAH November 16 2026 performance conversions CPA ROAS",
  "conversions and CPA for 2026-11-16",
])("grounds the dated note named in %j", async (queryText) => {
  const workspaceDir = await createTempWorkspace("openclaw-temporal-date-grounding-");
  const files = ["memory/2026-11-16.md", "memory/2026-11-24.md"];
  for (const file of files) {
    const filename = path.join(workspaceDir, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, "memory\n");
    const mtime = new Date(NOV_2026_MS - 2 * DAY_MS);
    await fs.utimes(filename, mtime, mtime);
  }
  const results = files.map((file) => ({ path: file, score: 1, source: "memory" }));
  const ranked = await applyTemporalDecayToHybridResults({
    results,
    workspaceDir,
    temporalDecay: { enabled: true, halfLifeDays: 30 },
    nowMs: NOV_2026_MS,
    queryText,
  });
  // Dated notes decay from their embedded date: 10 days before NOW_MS.
  expect(scoreOf(ranked, "memory/2026-11-16.md")).toBeCloseTo(0.5 ** (10 / 30) * 1.25, 3);
  expect(scoreOf(ranked, "memory/2026-11-24.md")).toBeCloseTo(0.5 ** (2 / 30), 3);
});

it("does not ground notes when the query names no date", async () => {
  const workspaceDir = await createTempWorkspace("openclaw-temporal-date-grounding-off-");
  const files = ["memory/2026-11-16.md", "memory/2026-11-24.md"];
  for (const file of files) {
    const filename = path.join(workspaceDir, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, "memory\n");
    const mtime = new Date(NOV_2026_MS - 2 * DAY_MS);
    await fs.utimes(filename, mtime, mtime);
  }
  const results = files.map((file) => ({ path: file, score: 1, source: "memory" }));
  const ranked = await applyTemporalDecayToHybridResults({
    results,
    workspaceDir,
    temporalDecay: { enabled: true, halfLifeDays: 30 },
    nowMs: NOV_2026_MS,
    queryText: "HKAH performance conversions CPA ROAS",
  });
  expect(scoreOf(ranked, "memory/2026-11-16.md")).toBeCloseTo(0.5 ** (10 / 30), 3);
  expect(scoreOf(ranked, "memory/2026-11-24.md")).toBeCloseTo(0.5 ** (2 / 30), 3);
});
