import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

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
