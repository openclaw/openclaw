import * as stringCoerce from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { dedupeEntries, prioritizeLightEntriesByDiaryCoverage } from "./dreaming-snippet-dedupe.js";
import type { ShortTermRecallEntry } from "./short-term-promotion.js";

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/string-coerce-runtime")>();
  return {
    ...actual,
    normalizeLowercaseStringOrEmpty: vi.fn(actual.normalizeLowercaseStringOrEmpty),
  };
});

const tokenizations = vi.mocked(stringCoerce.normalizeLowercaseStringOrEmpty);
beforeEach(() => tokenizations.mockClear());

function recallEntry(index: number, path: string, snippet: string): ShortTermRecallEntry {
  return {
    key: String(index),
    path,
    startLine: index,
    endLine: index,
    source: "memory",
    snippet,
    recallCount: 1,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 0.8,
    maxScore: 0.8,
    firstRecalledAt: "2026-04-05T09:00:00.000Z",
    lastRecalledAt: "2026-04-05T09:00:00.000Z",
    queryHashes: [`q${index}`],
    recallDays: ["2026-04-05"],
    conceptTags: [],
  };
}

it("deduplicates within a path, preserving tokenless snippets and preparing each input once", () => {
  const shared = "Rotate the staging access keys every quarter and record the rotation date.";
  const entries = [
    recallEntry(1, "memory/a.md", shared),
    recallEntry(2, "memory/b.md", shared),
    recallEntry(3, "memory/a.md", `${shared} Also`),
    recallEntry(4, "memory/a.md", "Completely unrelated gardening schedule for spring."),
    recallEntry(5, "memory/a.md", "!!!"),
    recallEntry(6, "memory/a.md", "???"),
  ];
  expect(dedupeEntries(entries, 0.88).map((entry) => entry.sourceEntryKeys)).toEqual([
    ["1", "3"],
    ["2"],
    ["4"],
    ["5"],
    ["6"],
  ]);
  // Tokenless inputs lowercase twice; pairwise re-tokenization exceeds this budget.
  expect(tokenizations.mock.calls.length).toBeLessThanOrEqual(entries.length + 2);
});

it("prioritizes fresh entries and prepares each candidate and diary page once", () => {
  const covered = recallEntry(1, "memory/a.md", "Queue hydration changed after plugin reload.");
  const near = recallEntry(2, "memory/a.md", "queue hydration changed after the plugin reload");
  const fresh = recallEntry(3, "memory/a.md", "Gardening schedule for spring planting.");

  const entries = [covered, near, fresh];
  const diary = ["Today: queue hydration changed after plugin reload, again."];
  expect(prioritizeLightEntriesByDiaryCoverage(entries, diary)).toEqual([fresh, covered, near]);
  expect(tokenizations.mock.calls.length).toBeLessThanOrEqual(entries.length + diary.length);
});
