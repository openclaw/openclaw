import * as fs from "node:fs";
import { describe, expect, test } from "vitest";
import { DEDUPE_THRESHOLD, dedupeData, dedupeFile } from "../src/dedupe.js";
import type { LessonsFile } from "../src/types.js";
import { makeFile, makeFixture, makeLesson, readJson, writeLessons } from "./helpers.js";

describe("dedupe", () => {
  test("merge keeps higher-severity lesson and archives the loser", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "pnpm install hooks",
        tags: ["pnpm", "install"],
        category: "infra",
        severity: "important",
      }),
      makeLesson({
        id: "B",
        title: "pnpm install hooks",
        tags: ["pnpm", "install"],
        category: "infra",
        severity: "high",
      }),
    ]);
    const { next, merges } = dedupeData(file);
    expect(merges).toHaveLength(1);
    expect(merges[0].keepId).toBe("B");
    expect(merges[0].mergedId).toBe("A");
    expect(merges[0].similarity).toBeGreaterThanOrEqual(DEDUPE_THRESHOLD);
    const b = next.lessons.find((l) => l.id === "B")!;
    const a = next.lessons.find((l) => l.id === "A")!;
    expect(b.lifecycle).toBe("active");
    expect(a.lifecycle).toBe("archive");
    expect(a.duplicateOf).toBe("B");
    expect(b.mergedFrom).toEqual(["A"]);
  });

  test("merge keeps higher hitCount when severity ties", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "flaky build cache invalidation",
        tags: ["cache", "build"],
        category: "ci",
        hitCount: 1,
      }),
      makeLesson({
        id: "B",
        title: "flaky build cache invalidation",
        tags: ["cache", "build"],
        category: "ci",
        hitCount: 7,
      }),
    ]);
    const { merges } = dedupeData(file);
    expect(merges[0].keepId).toBe("B");
    expect(merges[0].mergedId).toBe("A");
  });

  test("mergedFrom/duplicateOf/lifecycle form a complete audit chain", () => {
    const file = makeFile([
      makeLesson({
        id: "KEEP",
        title: "same same same",
        tags: ["x"],
        category: "k",
        severity: "high",
      }),
      makeLesson({
        id: "MERGE1",
        title: "same same same",
        tags: ["y"],
        category: "k",
        severity: "minor",
      }),
    ]);
    const { next } = dedupeData(file);
    const keep = next.lessons.find((l) => l.id === "KEEP")!;
    const merged = next.lessons.find((l) => l.id === "MERGE1")!;
    expect(keep.mergedFrom).toContain("MERGE1");
    expect(merged.duplicateOf).toBe("KEEP");
    expect(merged.lifecycle).toBe("archive");
    expect(keep.lifecycle).toBe("active");
  });

  test("tags are unioned on the surviving lesson", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "duplicate tags union test",
        tags: ["a", "b"],
        category: "x",
        severity: "high",
      }),
      makeLesson({
        id: "B",
        title: "duplicate tags union test",
        tags: ["b", "c"],
        category: "x",
        severity: "minor",
      }),
    ]);
    const { next } = dedupeData(file);
    const keep = next.lessons.find((l) => l.id === "A")!;
    expect(new Set(keep.tags)).toEqual(new Set(["a", "b", "c"]));
  });

  test("below-threshold pairs are left alone", () => {
    const file = makeFile([
      makeLesson({
        id: "A",
        title: "completely different topic alpha",
        tags: ["alpha"],
        category: "red",
      }),
      makeLesson({
        id: "B",
        title: "totally unrelated matter beta zebra",
        tags: ["beta"],
        category: "blue",
      }),
    ]);
    const { merges, next } = dedupeData(file);
    expect(merges).toHaveLength(0);
    expect(next.lessons.every((l) => l.lifecycle === "active")).toBe(true);
  });

  test("falls back to lexicographic id when severity, hitCount, and createdAt tie", () => {
    const file = makeFile([
      makeLesson({
        id: "B",
        title: "same title",
        tags: ["same"],
        category: "same",
        createdAt: "invalid",
      }),
      makeLesson({
        id: "A",
        title: "same title",
        tags: ["same"],
        category: "same",
        createdAt: "invalid",
      }),
    ]);
    const { merges } = dedupeData(file);
    expect(merges[0]?.keepId).toBe("A");
  });
});

describe("dedupe file", () => {
  test("missing files return an empty result", () => {
    const fx = makeFixture();
    try {
      const result = dedupeFile({
        filePath: fx.agentFile("builder"),
        agent: "builder",
        dryRun: true,
      });
      expect(result.totalLessons).toBe(0);
      expect(result.merges).toEqual([]);
      expect(result.wrote).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("apply mode writes merged content", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          makeLesson({ id: "A", title: "same title", tags: ["a"], category: "x" }),
          makeLesson({ id: "B", title: "same title", tags: ["b"], category: "x" }),
        ],
      });
      const result = dedupeFile({
        filePath,
        agent: "builder",
        dryRun: false,
        now: new Date("2026-04-13T00:00:00Z"),
      });
      expect(result.wrote).toBe(true);
      const after = readJson<LessonsFile>(filePath);
      expect(after.lessons.find((lesson) => lesson.id === "B")?.duplicateOf).toBe("A");
    } finally {
      fx.cleanup();
    }
  });

  test("apply mode does not rewrite when there are no merges", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          makeLesson({ id: "A", title: "database migrations", tags: ["db"], category: "db" }),
          makeLesson({ id: "B", title: "css layout", tags: ["css"], category: "ui" }),
        ],
      });
      const before = fs.readFileSync(filePath, "utf8");
      const result = dedupeFile({
        filePath,
        agent: "builder",
        dryRun: false,
      });
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  test("merge appends merged lesson id to mergedFrom (no lineage flatten, no metric carry)", () => {
    const file = makeFile([
      makeLesson({
        id: "KEEP",
        title: "same title",
        tags: ["keep"],
        category: "workflow",
        severity: "high",
        mergedFrom: ["older"],
        hitCount: 2,
        appliedCount: 1,
        lastHitAt: "2026-04-10T00:00:00Z",
      }),
      makeLesson({
        id: "MERGE",
        title: "same title",
        tags: ["merge"],
        category: "workflow",
        severity: "minor",
        mergedFrom: ["oldest"],
        hitCount: 5,
        appliedCount: 2,
        lastHitAt: "2026-04-12T00:00:00Z",
      }),
    ]);
    const { next } = dedupeData(file);
    const keep = next.lessons.find((lesson) => lesson.id === "KEEP")!;
    expect(keep.mergedFrom).toEqual(expect.arrayContaining(["older", "MERGE"]));
    expect(keep.hitCount).toBe(2);
    expect(keep.appliedCount).toBe(1);
    expect(keep.lastHitAt).toBe("2026-04-10T00:00:00Z");
  });

  test("three matching lessons collapse into two merges without double-merging archived losers", () => {
    const file = makeFile([
      makeLesson({ id: "A", title: "same title", tags: ["a"], category: "workflow" }),
      makeLesson({ id: "B", title: "same title", tags: ["b"], category: "workflow" }),
      makeLesson({ id: "C", title: "same title", tags: ["c"], category: "workflow" }),
    ]);
    const { next, merges } = dedupeData(file);
    expect(merges).toHaveLength(2);
    expect(next.lessons.filter((lesson) => lesson.lifecycle === "archive")).toHaveLength(2);
  });

  test("dedupe tolerates missing tags and mergedFrom arrays", () => {
    const file = {
      version: 1,
      lessons: [
        {
          id: "A",
          title: "same title",
          category: "workflow",
          createdAt: "2026-01-01T00:00:00Z",
          severity: "high",
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          duplicateOf: null,
          lifecycle: "active",
        },
        {
          id: "B",
          title: "same title",
          category: "workflow",
          createdAt: "2026-01-01T00:00:00Z",
          severity: "minor",
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          duplicateOf: null,
          lifecycle: "active",
        },
      ],
    } as unknown as LessonsFile;
    const { next } = dedupeData(file);
    const keep = next.lessons.find((lesson) => lesson.id === "A")!;
    expect(keep.tags).toEqual([]);
    expect(keep.mergedFrom).toContain("B");
  });
});
