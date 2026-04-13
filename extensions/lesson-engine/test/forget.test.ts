import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_MAX_ACTIVE, forgetData, forgetFile, scoreLesson } from "../src/forget.js";
import { makeFile, makeFixture, makeLesson, writeLessons } from "./helpers.js";

const NOW = new Date("2026-04-13T00:00:00Z");

describe("forget scoring", () => {
  test("score components for a fresh critical-severity lesson", () => {
    const lesson = makeLesson({
      id: "X",
      severity: "critical",
      createdAt: "2026-04-13T00:00:00Z",
      hitCount: 0,
      appliedCount: 0,
    });
    const s = scoreLesson(lesson, NOW);
    expect(s.recency).toBeCloseTo(1.0, 5);
    expect(s.usefulness).toBe(0);
    expect(s.severity).toBe(1.0);
    // 0.4*1 + 0.4*0 + 0.2*1 = 0.6
    expect(s.total).toBeCloseTo(0.6, 5);
  });

  test("usefulness saturates at 1", () => {
    const lesson = makeLesson({
      id: "X",
      severity: "minor",
      createdAt: "2025-01-01T00:00:00Z",
      hitCount: 2,
      appliedCount: 5, // (2 + 10) / 10 = 1.2 clipped to 1
    });
    const s = scoreLesson(lesson, NOW);
    expect(s.usefulness).toBe(1);
    expect(s.severity).toBe(0.2);
  });

  test("severity weights: critical=1.0 high=0.75 important=0.5 minor=0.2", () => {
    const base = { id: "X", createdAt: "2026-04-13T00:00:00Z" } as const;
    expect(scoreLesson(makeLesson({ ...base, severity: "critical" }), NOW).severity).toBe(1.0);
    expect(scoreLesson(makeLesson({ ...base, severity: "high" }), NOW).severity).toBe(0.75);
    expect(scoreLesson(makeLesson({ ...base, severity: "important" }), NOW).severity).toBe(0.5);
    expect(scoreLesson(makeLesson({ ...base, severity: "minor" }), NOW).severity).toBe(0.2);
  });

  test("invalid timestamps fall back to a very old age", () => {
    const s = scoreLesson(makeLesson({ id: "X", createdAt: "invalid-date" }), NOW);
    expect(s.daysSinceLastHit).toBeGreaterThan(3000);
  });

  test("unknown severities fall back to important scoring", () => {
    const lesson = makeLesson({ id: "X", severity: "important" });
    (lesson as { severity: string }).severity = "unknown";
    expect(scoreLesson(lesson, NOW).severity).toBe(0.5);
  });
});

describe("forget lifecycle transitions", () => {
  test("active > maxActive: lowest-scoring tail demoted to stale", () => {
    const lessons = [];
    for (let i = 0; i < DEFAULT_MAX_ACTIVE + 5; i++) {
      lessons.push(
        makeLesson({
          id: `L-${i}`,
          severity: "important",
          // older (lower recency) ⇒ demoted first
          createdAt: new Date(NOW.getTime() - (i + 1) * 86400_000 * 60).toISOString(),
        }),
      );
    }
    const file = makeFile(lessons);
    const { next, transitions } = forgetData(file, { now: NOW });
    const active = next.lessons.filter((l) => l.lifecycle === "active");
    const stale = next.lessons.filter((l) => l.lifecycle === "stale");
    expect(active).toHaveLength(DEFAULT_MAX_ACTIVE);
    expect(stale).toHaveLength(5);
    expect(transitions.every((t) => t.from === "active" && t.to === "stale")).toBe(true);
    // oldest (highest i) should be the ones demoted
    expect(stale.map((l) => l.id).sort()).toEqual(["L-54", "L-53", "L-52", "L-51", "L-50"].sort());
  });

  test("stale + daysSinceLastHit > 90 → archive", () => {
    const lessons = [
      makeLesson({
        id: "old-stale",
        severity: "minor",
        lifecycle: "stale",
        lastHitAt: null,
        createdAt: new Date(NOW.getTime() - 120 * 86400_000).toISOString(),
      }),
      makeLesson({
        id: "fresh-stale",
        severity: "minor",
        lifecycle: "stale",
        lastHitAt: new Date(NOW.getTime() - 10 * 86400_000).toISOString(),
      }),
    ];
    const { next, transitions } = forgetData(makeFile(lessons), { now: NOW });
    const old = next.lessons.find((l) => l.id === "old-stale")!;
    const fresh = next.lessons.find((l) => l.id === "fresh-stale")!;
    expect(old.lifecycle).toBe("archive");
    expect(fresh.lifecycle).toBe("stale");
    expect(transitions).toContainEqual(
      expect.objectContaining({ id: "old-stale", from: "stale", to: "archive" }),
    );
  });

  test("never deletes: archived lessons stay in the file", () => {
    const lessons = [
      makeLesson({
        id: "a",
        severity: "minor",
        lifecycle: "stale",
        createdAt: new Date(NOW.getTime() - 200 * 86400_000).toISOString(),
      }),
    ];
    const file = makeFile(lessons);
    const beforeCount = file.lessons.length;
    const { next } = forgetData(file, { now: NOW });
    expect(next.lessons).toHaveLength(beforeCount);
  });

  test("ties fall back to lesson id when scores and createdAt match", () => {
    const { transitions } = forgetData(
      makeFile([
        makeLesson({ id: "b", title: "tie b", createdAt: "2026-04-01T00:00:00Z" }),
        makeLesson({ id: "a", title: "tie a", createdAt: "2026-04-01T00:00:00Z" }),
      ]),
      { now: NOW, maxActive: 1 },
    );
    expect(transitions[0]?.id).toBe("a");
  });

  test("forgetData uses file.maxActive and default now when options are omitted", () => {
    const { next } = forgetData(
      makeFile(
        [
          makeLesson({ id: "a", createdAt: "2026-04-01T00:00:00Z" }),
          makeLesson({ id: "b", createdAt: "2026-01-01T00:00:00Z" }),
        ],
        { maxActive: 1 },
      ),
    );
    expect(next.lessons.filter((lesson) => lesson.lifecycle === "active")).toHaveLength(1);
  });
});

describe("forget file", () => {
  test("missing files return defaults", () => {
    const fx = makeFixture();
    try {
      const result = forgetFile({
        filePath: path.join(fx.root, "builder", "memory", "lessons-learned.json"),
        agent: "builder",
        dryRun: true,
        maxActive: 7,
      });
      expect(result.maxActive).toBe(7);
      expect(result.totalLessons).toBe(0);
      expect(result.transitions).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("dry-run does not write", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          makeLesson({
            id: "old",
            lifecycle: "stale",
            createdAt: "2025-01-01T00:00:00Z",
          }),
        ],
      });
      const before = fs.readFileSync(filePath, "utf8");
      const result = forgetFile({
        filePath,
        agent: "builder",
        dryRun: true,
        now: NOW,
      });
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  test("apply mode writes transitions and uses file.maxActive when option is omitted", () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        maxActive: 1,
        lessons: [
          makeLesson({ id: "a", createdAt: "2026-04-01T00:00:00Z" }),
          makeLesson({ id: "b", createdAt: "2026-01-01T00:00:00Z" }),
        ],
      });
      const result = forgetFile({
        filePath,
        agent: "builder",
        dryRun: false,
        now: NOW,
      });
      expect(result.wrote).toBe(true);
      expect(result.maxActive).toBe(1);
      const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        lessons: Array<{ id: string; lifecycle: string }>;
      };
      expect(after.lessons.filter((lesson) => lesson.lifecycle === "active")).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });
});
