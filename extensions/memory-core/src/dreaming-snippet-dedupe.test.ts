import * as stringCoerce from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { dedupeEntries, prioritizeLightEntriesByDiaryCoverage } from "./dreaming-snippet-dedupe.js";
import type { ShortTermRecallEntry } from "./short-term-promotion.js";

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/string-coerce-runtime")>();
  return {
    ...actual,
    normalizeLowercaseStringOrEmpty: vi.fn(actual.normalizeLowercaseStringOrEmpty),
  };
});

// Every fixture snippet has tokens, so each preparation lowercases exactly once (token-less text lowercases twice).
function tokenizationCount(): number {
  return vi.mocked(stringCoerce.normalizeLowercaseStringOrEmpty).mock.calls.length;
}

function resetCounts(): void {
  vi.mocked(stringCoerce.normalizeLowercaseStringOrEmpty).mockClear();
}

function recallEntry(index: number, pathName: string, snippet: string): ShortTermRecallEntry {
  return {
    key: `memory:${pathName}:${index}:${index}`,
    path: pathName,
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

function distinctEntries(count: number): ShortTermRecallEntry[] {
  return Array.from({ length: count }, (_, index) =>
    recallEntry(
      index,
      `memory/2026-04-0${(index % 6) + 1}.md`,
      `Note ${index} about topic${index * 7} and detail${index * 13} in cluster${index % 17}.`,
    ),
  );
}

describe("dedupeEntries", () => {
  it("tokenizes each candidate once instead of once per comparison", () => {
    const entries = distinctEntries(600);
    resetCounts();

    expect(dedupeEntries(entries, 0.88)).toHaveLength(600);

    expect(tokenizationCount()).toBeLessThanOrEqual(600);
  });

  it("merges near-duplicate snippets only within the same path", () => {
    const shared = "Rotate the staging access keys every quarter and record the rotation date.";
    const deduped = dedupeEntries(
      [
        recallEntry(1, "memory/a.md", shared),
        recallEntry(2, "memory/b.md", shared),
        recallEntry(3, "memory/a.md", `${shared} Also`),
        recallEntry(4, "memory/a.md", "Completely unrelated gardening schedule for spring."),
      ],
      0.88,
    );

    expect(deduped.map((entry) => entry.sourceEntryKeys)).toEqual([
      ["memory:memory/a.md:1:1", "memory:memory/a.md:3:3"],
      ["memory:memory/b.md:2:2"],
      ["memory:memory/a.md:4:4"],
    ]);
  });

  it("keeps distinct non-alphabet snippets apart", () => {
    const deduped = dedupeEntries(
      [recallEntry(1, "memory/a.md", "!!!"), recallEntry(2, "memory/a.md", "???")],
      0.88,
    );

    expect(deduped).toHaveLength(2);
  });
});

describe("prioritizeLightEntriesByDiaryCoverage", () => {
  it("tokenizes each recent diary page once across all candidates", () => {
    const entries = distinctEntries(240);
    const diary = [1, 2, 3, 4].map(
      (day) => `Diary page ${day} reflects on routing, queues and a long quiet afternoon.`,
    );
    resetCounts();

    prioritizeLightEntriesByDiaryCoverage(entries, diary);

    // One preparation per candidate plus one per diary page.
    expect(tokenizationCount()).toBeLessThanOrEqual(entries.length + diary.length);
  });

  it("moves candidates covered by a diary page behind fresh ones", () => {
    const covered = recallEntry(1, "memory/a.md", "Queue hydration changed after plugin reload.");
    const near = recallEntry(2, "memory/a.md", "queue hydration changed after the plugin reload");
    const fresh = recallEntry(3, "memory/a.md", "Gardening schedule for spring planting.");

    const ordered = prioritizeLightEntriesByDiaryCoverage(
      [covered, near, fresh],
      ["Today: queue hydration changed after plugin reload, again."],
    );

    expect(ordered).toEqual([fresh, covered, near]);
  });
});
