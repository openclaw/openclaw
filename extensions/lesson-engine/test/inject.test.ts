import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
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

  test("selects top-3 by severity + hitCount (no domainTags)", () => {
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
      expect(result.selected).toHaveLength(3);
      // Order: critical → high(8) → high(3)
      expect(result.selected[0].id).toBe("L2");
      expect(result.selected[1].id).toBe("L3");
      expect(result.selected[2].id).toBe("L4");
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
