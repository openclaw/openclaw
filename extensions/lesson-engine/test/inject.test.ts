import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { main } from "../cli/lesson-engine.js";
import { injectLessons } from "../src/inject.js";
import { makeFile, makeFixture, makeLesson, writeLessons } from "./helpers.js";

describe("injectLessons", () => {
  test("empty lessons → selected=0, no error", () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      expect(result.selected).toHaveLength(0);
      expect(result.totalLessons).toBe(0);
      expect(result.estimatedTokens).toBe(0);
      expect(result.outputPath).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test("no lessons file → selected=0, no error", () => {
    const fx = makeFixture();
    try {
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      expect(result.selected).toHaveLength(0);
      expect(result.totalLessons).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("selects top-10 by severity + hitCount (no domainTags)", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "minor", hitCount: 10, lesson: "minor lesson" }),
        makeLesson({ id: "L2", severity: "critical", hitCount: 5, lesson: "critical lesson" }),
        makeLesson({ id: "L3", severity: "high", hitCount: 8, lesson: "high lesson" }),
        makeLesson({ id: "L4", severity: "high", hitCount: 3, lesson: "high lesson two" }),
        makeLesson({ id: "L5", severity: "important", hitCount: 1, lesson: "important lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      // MAX_LESSONS=10 > fixture size (5), so all 5 are selected
      expect(result.selected).toHaveLength(5);
      // Priority order: critical → high(8) → high(3) → important → minor
      expect(result.selected[0].id).toBe("L2");
      expect(result.selected[1].id).toBe("L3");
      expect(result.selected[2].id).toBe("L4");
      expect(result.selected[3].id).toBe("L5");
      expect(result.selected[4].id).toBe("L1");
    } finally {
      fx.cleanup();
    }
  });

  test("maxLessons option overrides default cap", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson" }),
        makeLesson({ id: "L2", severity: "high", hitCount: 3, lesson: "high lesson" }),
        makeLesson({ id: "L3", severity: "important", hitCount: 1, lesson: "important lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        maxLessons: 1,
        dryRun: true,
      });
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0].id).toBe("L1");
    } finally {
      fx.cleanup();
    }
  });

  test("domainTags filter — only matching tags selected", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          tags: ["git", "workflow"],
          lesson: "git lesson",
        }),
        makeLesson({
          id: "L2",
          severity: "critical",
          hitCount: 5,
          tags: ["docker", "infra"],
          lesson: "docker lesson",
        }),
        makeLesson({
          id: "L3",
          severity: "high",
          hitCount: 3,
          tags: ["git", "merge"],
          lesson: "merge lesson",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        domainTags: ["docker"],
        dryRun: true,
      });
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0].id).toBe("L2");
    } finally {
      fx.cleanup();
    }
  });

  test("estimatedTokens exceeds maxTokens → truncates", () => {
    const fx = makeFixture();
    try {
      // Each lesson: title (~10 chars) + lesson (200 chars) + fix (200 chars) ≈ 410 chars → ~103 tokens
      const longText = "a".repeat(200);
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          lesson: longText,
          fix: longText,
        }),
        makeLesson({ id: "L2", severity: "high", hitCount: 3, lesson: longText, fix: longText }),
        makeLesson({
          id: "L3",
          severity: "important",
          hitCount: 1,
          lesson: longText,
          fix: longText,
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        maxTokens: 200,
        dryRun: true,
      });
      // Each lesson ~103 tokens; maxTokens=200 → at most 1 lesson
      expect(result.selected.length).toBeLessThanOrEqual(2);
      expect(result.estimatedTokens).toBeLessThanOrEqual(200);
    } finally {
      fx.cleanup();
    }
  });

  test("non-active lifecycle lessons excluded", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          lifecycle: "stale",
          lesson: "stale",
        }),
        makeLesson({
          id: "L2",
          severity: "critical",
          hitCount: 5,
          lifecycle: "archive",
          lesson: "archived",
        }),
        makeLesson({
          id: "L3",
          severity: "high",
          hitCount: 3,
          lifecycle: "active",
          lesson: "active",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0].id).toBe("L3");
      expect(result.totalLessons).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("dry-run does not write file", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson text" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      expect(result.outputPath).toBeNull();
      const outPath = path.join(fx.root, "builder", "memory", "injected-lessons.md");
      expect(fs.existsSync(outPath)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("apply appends a JSON line to lesson-injection-log.jsonl with required fields", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          tags: ["git"],
          lesson: "critical lesson text",
          fix: "fix text",
        }),
        makeLesson({
          id: "L2",
          severity: "high",
          hitCount: 2,
          tags: ["git"],
          lesson: "high lesson text",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: false });
      const logPath = path.join(fx.root, "builder", "memory", "lesson-injection-log.jsonl");
      expect(fs.existsSync(logPath)).toBe(true);
      const raw = fs.readFileSync(logPath, "utf8");
      const lines = raw.split("\n").filter((l: string) => l.length > 0);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.agent).toBe("builder");
      expect(Array.isArray(entry.selectedLessonIds)).toBe(true);
      expect(entry.selectedLessonIds).toEqual(result.selected.map((s) => s.id));
      expect(entry.selectedCount).toBe(result.selected.length);
      expect(entry.estimatedTokens).toBe(result.estimatedTokens);
      expect(entry.totalActiveLessons).toBe(result.totalLessons);
      expect(entry.maxLessons).toBe(10);
      expect(entry.maxTokens).toBe(2000);
    } finally {
      fx.cleanup();
    }
  });

  test("dry-run skips lesson-injection-log.jsonl write", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson text" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      injectLessons({ agent: "builder", root: fx.root, dryRun: true });
      const logPath = path.join(fx.root, "builder", "memory", "lesson-injection-log.jsonl");
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("renderMarkdown header reflects custom maxLessons (e.g. Top 5)", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson" }),
        makeLesson({ id: "L2", severity: "high", hitCount: 3, lesson: "high lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        maxLessons: 5,
        dryRun: false,
      });
      expect(result.outputPath).not.toBeNull();
      const content = fs.readFileSync(result.outputPath!, "utf8");
      expect(content).toContain("Top 5");
      expect(content).not.toContain("Top 10");
    } finally {
      fx.cleanup();
    }
  });

  test("jsonl injection-log write failure warns but does not throw", () => {
    const fx = makeFixture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson text" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      // Force the jsonl append to fail by pre-creating the log path as a directory
      // (EISDIR). Best-effort writes must warn and continue instead of throwing.
      const memoryDir = path.join(fx.root, "builder", "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.mkdirSync(path.join(memoryDir, "lesson-injection-log.jsonl"), { recursive: true });

      let result: ReturnType<typeof injectLessons> | undefined;
      expect(() => {
        result = injectLessons({ agent: "builder", root: fx.root, dryRun: false });
      }).not.toThrow();

      // Main path still completed (markdown written).
      expect(result).toBeDefined();
      expect(result!.outputPath).not.toBeNull();

      // console.warn must have surfaced the failure (match /injection log/i).
      expect(warnSpy).toHaveBeenCalled();
      const calls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => /injection log/i.test(m))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      fx.cleanup();
    }
  });

  test("apply writes injected-lessons.md", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          tags: ["git"],
          lesson: "critical lesson text",
          fix: "fix text",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: false });
      expect(result.outputPath).not.toBeNull();
      expect(fs.existsSync(result.outputPath!)).toBe(true);
      const content = fs.readFileSync(result.outputPath!, "utf8");
      expect(content).toContain("injected-lessons: auto-generated");
      expect(content).toContain("[critical]");
      expect(content).toContain("critical lesson text");
      expect(content).toContain("Fix: fix text");
      expect(content).toContain("`git`");
    } finally {
      fx.cleanup();
    }
  });

  test("pinned lessons always included regardless of maxLessons cap", () => {
    const fx = makeFixture();
    try {
      // 12 pinned lessons + 5 regular; maxLessons=3.
      const pinned = Array.from({ length: 12 }, (_, i) =>
        makeLesson({
          id: `P${i}`,
          severity: "important",
          hitCount: 0,
          tags: ["pinned", "rule"],
          lesson: `pinned rule ${i}`,
        }),
      );
      const regular = Array.from({ length: 5 }, (_, i) =>
        makeLesson({
          id: `R${i}`,
          severity: "critical",
          hitCount: 10,
          tags: ["runtime"],
          lesson: `regular ${i}`,
        }),
      );
      writeLessons(fx, "builder", makeFile([...pinned, ...regular]));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        maxLessons: 3,
        dryRun: true,
      });
      const pinnedIds = result.selected.filter((s) => s.tags.includes("pinned")).map((s) => s.id);
      const regularIds = result.selected.filter((s) => !s.tags.includes("pinned")).map((s) => s.id);
      expect(pinnedIds).toHaveLength(12); // all pinned included
      expect(regularIds).toHaveLength(3); // regular capped at maxLessons=3
    } finally {
      fx.cleanup();
    }
  });

  test("pinned lessons ignore domainTags filter", () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "P1",
          severity: "high",
          tags: ["pinned", "review"],
          lesson: "pinned review rule",
        }),
        makeLesson({
          id: "R1",
          severity: "high",
          tags: ["deployment"],
          lesson: "regular deployment",
        }),
        makeLesson({
          id: "R2",
          severity: "high",
          tags: ["review"],
          lesson: "regular review",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const result = injectLessons({
        agent: "builder",
        root: fx.root,
        domainTags: ["deployment"],
        dryRun: true,
      });
      const ids = result.selected.map((s) => s.id);
      // P1 included even though its tags don't match "deployment"
      // R1 included (matches), R2 excluded (doesn't match)
      expect(ids).toContain("P1");
      expect(ids).toContain("R1");
      expect(ids).not.toContain("R2");
    } finally {
      fx.cleanup();
    }
  });

  test("pinned section renders with its own header in markdown", () => {
    const fx = makeFixture();
    try {
      writeLessons(
        fx,
        "builder",
        makeFile([
          makeLesson({
            id: "P1",
            severity: "critical",
            tags: ["pinned"],
            title: "pinned title",
            lesson: "pinned lesson body",
          }),
          makeLesson({
            id: "R1",
            severity: "high",
            tags: ["runtime"],
            title: "regular title",
            lesson: "regular lesson body",
          }),
        ]),
      );
      const result = injectLessons({ agent: "builder", root: fx.root, dryRun: false });
      const content = fs.readFileSync(result.outputPath!, "utf8");
      expect(content).toContain("长期规则（Pinned");
      expect(content).toContain("注入教训");
      // Pinned header must appear before the regular header
      const pinnedIdx = content.indexOf("长期规则");
      const regularIdx = content.indexOf("注入教训");
      expect(pinnedIdx).toBeGreaterThanOrEqual(0);
      expect(pinnedIdx).toBeLessThan(regularIdx);
    } finally {
      fx.cleanup();
    }
  });

  test("injection log records pinnedCount and regularCount", () => {
    const fx = makeFixture();
    try {
      writeLessons(
        fx,
        "builder",
        makeFile([
          makeLesson({ id: "P1", tags: ["pinned"], severity: "high", lesson: "p1" }),
          makeLesson({ id: "P2", tags: ["pinned"], severity: "high", lesson: "p2" }),
          makeLesson({ id: "R1", tags: [], severity: "critical", lesson: "r1" }),
        ]),
      );
      injectLessons({ agent: "builder", root: fx.root, dryRun: false });
      const logPath = path.join(fx.root, "builder", "memory", "lesson-injection-log.jsonl");
      const raw = fs.readFileSync(logPath, "utf8").trim();
      const entry = JSON.parse(raw);
      expect(entry.pinnedCount).toBe(2);
      expect(entry.regularCount).toBe(1);
      expect(entry.selectedCount).toBe(3);
    } finally {
      fx.cleanup();
    }
  });
});

describe("CLI inject", () => {
  test("inject --agent builder --dry-run outputs command and dryRun", async () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", makeFile([]));
      const { stdout, exitCode } = await main([
        "inject",
        "--agent",
        "builder",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as { command: string; dryRun: boolean };
      expect(out.command).toBe("inject");
      expect(out.dryRun).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("inject --agent builder --apply writes injected-lessons.md", async () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "test lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const { stdout, exitCode } = await main([
        "inject",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as { command: string; dryRun: boolean; results: { outputPath: string }[] };
      expect(out.dryRun).toBe(false);
      expect(out.results[0].outputPath).toBeTruthy();
      expect(fs.existsSync(out.results[0].outputPath)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("inject --all processes all agents", async () => {
    const fx = makeFixture();
    try {
      for (const agent of ["builder", "architect", "chief", "growth"]) {
        writeLessons(fx, agent, makeFile([]));
      }
      const { stdout, exitCode } = await main(["inject", "--all", "--dry-run", "--root", fx.root]);
      expect(exitCode).toBe(0);
      const out = stdout as { results: { agent: string }[] };
      expect(out.results).toHaveLength(4);
    } finally {
      fx.cleanup();
    }
  });

  test("inject --domain-tags filters by tags", async () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          tags: ["git"],
          lesson: "git lesson",
        }),
        makeLesson({
          id: "L2",
          severity: "critical",
          hitCount: 5,
          tags: ["docker"],
          lesson: "docker lesson",
        }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const { stdout, exitCode } = await main([
        "inject",
        "--agent",
        "builder",
        "--domain-tags",
        "docker",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as { results: { selected: number }[] };
      expect(out.results[0].selected).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("inject --max-lessons overrides default cap", async () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "critical lesson" }),
        makeLesson({ id: "L2", severity: "high", hitCount: 3, lesson: "high lesson" }),
        makeLesson({ id: "L3", severity: "important", hitCount: 1, lesson: "important lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const { stdout, exitCode } = await main([
        "inject",
        "--agent",
        "builder",
        "--max-lessons",
        "1",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as { results: { selected: number }[] };
      // --max-lessons 1 → only top 1 lesson selected
      expect(out.results[0].selected).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("inject --max-tokens overrides default budget", async () => {
    const fx = makeFixture();
    try {
      const longText = "a".repeat(200);
      const lessons = [
        makeLesson({
          id: "L1",
          severity: "critical",
          hitCount: 5,
          lesson: longText,
          fix: longText,
        }),
        makeLesson({ id: "L2", severity: "high", hitCount: 3, lesson: longText, fix: longText }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const { stdout, exitCode } = await main([
        "inject",
        "--agent",
        "builder",
        "--max-tokens",
        "50",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as { results: { selected: number; estimatedTokens: number }[] };
      // Each lesson ~103 tokens; budget=50 → none fit
      expect(out.results[0].selected).toBe(0);
      expect(out.results[0].estimatedTokens).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("maintenance --apply includes injectResults", async () => {
    const fx = makeFixture();
    try {
      const lessons = [
        makeLesson({ id: "L1", severity: "critical", hitCount: 5, lesson: "important lesson" }),
      ];
      writeLessons(fx, "builder", makeFile(lessons));
      const { stdout, stderr, exitCode } = await main([
        "maintenance",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const out = stdout as {
        injectResults: { agent: string; selected: number; estimatedTokens: number }[];
      };
      expect(out.injectResults).toBeDefined();
      expect(out.injectResults).toHaveLength(1);
      expect(out.injectResults[0].agent).toBe("builder");
      expect(out.injectResults[0].selected).toBeGreaterThanOrEqual(0);
      // stderr should contain inject log line
      expect(stderr.some((l: string) => l.includes("[inject]"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
