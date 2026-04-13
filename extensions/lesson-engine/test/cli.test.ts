import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../cli/lesson-engine.js";
import type { DedupeResult } from "../src/dedupe.js";
import { MockProvider, readCandidatesFile, type DistillLLMProvider } from "../src/distill.js";
import { writeSeedsAppend } from "../src/error-scanner.js";
import type { ForgetResult } from "../src/forget.js";
import type { MigrateResult } from "../src/migrate.js";
import type { ErrorSeed, MaintenanceState } from "../src/types.js";
import { makeFixture, writeLessons } from "./helpers.js";

const MOCK_LLM_RESPONSE = JSON.stringify({
  title: "Avoid reading protected files",
  category: "filesystem",
  tags: ["permissions", "security"],
  context: "When the agent tries to read system files",
  mistake: "Attempting to read files without proper permissions",
  lesson: "Always check file permissions before reading",
  fix: "Use stat to check permissions before reading system files",
  severity: "high",
  confidence: 0.85,
});

function makeCLISeed(agent: string, fingerprint: string, sessionKey: string): ErrorSeed {
  return {
    sessionKey,
    agent,
    tool: "Bash",
    errorClass: "Permission denied",
    errorMessage: "Permission denied",
    fingerprint,
    domainTags: [],
    timestamp: new Date().toISOString(),
    sessionTimestamp: new Date().toISOString(),
  };
}

describe("CLI", () => {
  test("rejects unknown agent with exit code 1", async () => {
    const { stdout, exitCode } = await main(["migrate", "--agent", "nope"]);
    expect(exitCode).toBe(1);
    expect((stdout as { error: string }).error).toMatch(/Unknown agent/);
  });

  test("migrate --dry-run reports diff without writing", async () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", title: "t" }],
      });
      const before = fs.readFileSync(filePath, "utf8");
      const { stdout, exitCode } = await main([
        "migrate",
        "--agent",
        "builder",
        "--dry-run",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (stdout as { results: MigrateResult[] }).results;
      expect(results[0].wrote).toBe(false);
      expect(results[0].mutatedCount).toBeGreaterThan(0);
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fx.cleanup();
    }
  });

  test("migrate --apply writes migrated file + backup", async () => {
    const fx = makeFixture();
    try {
      const filePath = writeLessons(fx, "builder", {
        version: 1,
        lessons: [{ id: "l1", severity: "critical", title: "t" }],
      });
      const { stdout, exitCode } = await main([
        "migrate",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (stdout as { results: MigrateResult[] }).results;
      expect(results[0].wrote).toBe(true);
      expect(fs.existsSync(results[0].backupPath!)).toBe(true);
      const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(after.lessons[0].severity).toBe("critical");
    } finally {
      fx.cleanup();
    }
  });

  test("maintenance --apply updates shared maintenance-state.json", async () => {
    const fx = makeFixture();
    try {
      const lessons = [];
      for (let i = 0; i < 52; i++) {
        lessons.push({
          id: `L-${i}`,
          title: `lesson ${i}`,
          category: "general",
          tags: [`t${i}`],
          severity: "important",
          createdAt: new Date(Date.now() - i * 86400_000).toISOString(),
          hitCount: 0,
          appliedCount: 0,
          lastHitAt: null,
          mergedFrom: [],
          duplicateOf: null,
          lifecycle: "active",
        });
      }
      writeLessons(fx, "builder", { version: 1, lessons });
      const { stdout, exitCode } = await main([
        "maintenance",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (
        stdout as {
          results: { dedupe: DedupeResult; forget: ForgetResult; statePath?: string }[];
        }
      ).results;
      expect(results[0].forget.wrote).toBe(true);
      expect(results[0].forget.activeAfter).toBeLessThanOrEqual(50);
      const statePath = results[0].statePath!;
      expect(statePath).toBeDefined();
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.version).toBe(1);
      expect(state.agents.builder.lastMaintenanceAt).toBeTruthy();
      expect(state.agents.builder.forgetStale).toBeGreaterThanOrEqual(2);
      expect(statePath.startsWith(fx.root)).toBe(true);
      const after = JSON.parse(
        fs.readFileSync(path.join(fx.root, "builder", "memory", "lessons-learned.json"), "utf8"),
      );
      expect(after.lessons.length).toBe(52);
    } finally {
      fx.cleanup();
    }
  });

  test("maintenance migrates unmigrated data before dedupe/forget", async () => {
    const fx = makeFixture();
    try {
      // Unmigrated input: no lifecycle, no severity on any lesson.
      writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          { id: "a", title: "pnpm install hooks", tags: ["pnpm"], category: "infra" },
          { id: "b", title: "pnpm install hooks", tags: ["pnpm"], category: "infra" },
        ],
      });
      const { stdout, exitCode } = await main([
        "maintenance",
        "--agent",
        "builder",
        "--apply",
        "--root",
        fx.root,
      ]);
      expect(exitCode).toBe(0);
      const results = (
        stdout as {
          results: {
            migrate: MigrateResult;
            dedupe: DedupeResult;
            forget: ForgetResult;
            statePath?: string;
          }[];
        }
      ).results;
      // migrate ran first and mutated both lessons (adding lifecycle + severity)
      expect(results[0].migrate.wrote).toBe(true);
      expect(results[0].migrate.mutatedCount).toBe(2);
      // dedupe then sees two active lessons and merges them
      expect(results[0].dedupe.merges.length).toBe(1);
      // state records lastMigrateAt
      const state = JSON.parse(fs.readFileSync(results[0].statePath!, "utf8")) as MaintenanceState;
      expect(state.agents.builder.lastMigrateAt).toBeTruthy();
    } finally {
      fx.cleanup();
    }
  });

  test("status reports per-lifecycle counts", async () => {
    const fx = makeFixture();
    try {
      writeLessons(fx, "builder", {
        version: 1,
        lessons: [
          { id: "a", lifecycle: "active" },
          { id: "b", lifecycle: "stale" },
          { id: "c", lifecycle: "archive" },
        ],
      });
      const { stdout, exitCode } = await main(["status", "--agent", "builder", "--root", fx.root]);
      expect(exitCode).toBe(0);
      const r = (stdout as { results: { active: number; stale: number; archive: number }[] })
        .results[0];
      expect(r.active).toBe(1);
      expect(r.stale).toBe(1);
      expect(r.archive).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("distill --agent builder only generates candidates for builder seeds", async () => {
    const fx = makeFixture();
    try {
      const builderSeeds = [
        makeCLISeed("builder", "fp-builder", "sess-b1"),
        makeCLISeed("builder", "fp-builder", "sess-b2"),
      ];
      const chiefSeeds = [
        makeCLISeed("chief", "fp-chief", "sess-c1"),
        makeCLISeed("chief", "fp-chief", "sess-c2"),
      ];
      writeSeedsAppend([...builderSeeds, ...chiefSeeds], fx.root);
      const { stdout, exitCode } = await main(
        ["distill", "--agent", "builder", "--apply", "--root", fx.root],
        { llm: new MockProvider(MOCK_LLM_RESPONSE) },
      );
      expect(exitCode).toBe(0);
      expect((stdout as any).newCandidates).toBe(1);
      const file = readCandidatesFile(fx.root);
      expect(file.candidates).toHaveLength(1);
      expect(file.candidates[0].agent).toBe("builder");
    } finally {
      fx.cleanup();
    }
  });

  test("distill --all invokes LLM with correct agent context per cluster", async () => {
    const fx = makeFixture();
    try {
      const builderSeeds = [
        makeCLISeed("builder", "fp-b", "sess-b1"),
        makeCLISeed("builder", "fp-b", "sess-b2"),
      ];
      const chiefSeeds = [
        makeCLISeed("chief", "fp-c", "sess-c1"),
        makeCLISeed("chief", "fp-c", "sess-c2"),
      ];
      writeSeedsAppend([...builderSeeds, ...chiefSeeds], fx.root);
      const captured: string[] = [];
      const cap: DistillLLMProvider = {
        async complete(p) {
          captured.push(p);
          return MOCK_LLM_RESPONSE;
        },
      };
      const { stdout, exitCode } = await main(["distill", "--all", "--apply", "--root", fx.root], {
        llm: cap,
      });
      expect(exitCode).toBe(0);
      expect(captured.some((p) => p.includes('"builder"'))).toBe(true);
      expect(captured.some((p) => p.includes('"chief"'))).toBe(true);
      expect((stdout as any).newCandidates).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});
