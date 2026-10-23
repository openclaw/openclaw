import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 1, 10, 0, 0, 0);
const { createTempWorkspace } = createMemoryCoreTestHarness();

const decay = (
  options: Omit<Parameters<typeof applyTemporalDecayToHybridResults>[0], "temporalDecay" | "nowMs">,
) =>
  applyTemporalDecayToHybridResults({
    ...options,
    temporalDecay: { enabled: true, halfLifeDays: 30 },
    nowMs: NOW_MS,
  });
const memoryEntry = (file: string, score = 1) => ({ path: file, score, source: "memory" });
async function workspaceFiles(files: string[], ageDays: number) {
  const dir = await createTempWorkspace("openclaw-temporal-decay-");
  const mtime = new Date(NOW_MS - ageDays * DAY_MS);
  await Promise.all(
    files.map(async (file) => {
      const absolute = path.join(dir, file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, "memory\n");
      await fs.utimes(absolute, mtime, mtime);
    }),
  );
  return dir;
}

describe("temporal decay", () => {
  it.each([
    ["notes/topic.md", 30, 1, undefined, false, 0.5],
    ["reference/topic.md", 300, 0.8, "reference", false, 0.8],
    ["memory/2026-01-11.md", 0, 1, "memory", false, 0.5],
    ["memory/2026-01-11.md", 0, 1, "memory", true, 0.5],
    ["MEMORY.md", 90, 1, undefined, false, 1],
  ] as const)(
    "ranks %s with mtime age %s and score %s under %s policy (absolute=%s)",
    async (file, age, score, extra, absolute, expected) => {
      const dir = await workspaceFiles([file], age);
      const filePath = absolute ? path.join(dir, file) : file;
      const decayed = await decay({
        results: [memoryEntry(filePath, score)],
        workspaceDir: dir,
        extraPaths: extra ? [{ path: extra, evergreen: true }] : undefined,
        // Canonical dates and evergreen roots must win over conflicting indexed mtimes.
        memorySourceMtimes:
          file.startsWith("memory/") || file === "MEMORY.md"
            ? new Map([[filePath, NOW_MS - 90 * DAY_MS]])
            : undefined,
      });
      expect(decayed[0]?.score).toBeCloseTo(expected, 2);
    },
  );

  it.each(["local", "indexed-host"] as const)(
    "applies evergreen only to matching files with %s timestamps",
    async (mtimeSource) => {
      const files = ["notes/stable/topic.md", "notes/dated/topic.md"];
      // Indexed host timestamps must win over the gateway filesystem.
      const dir = await workspaceFiles(files, mtimeSource === "local" ? 30 : 0);

      const byPath = new Map(
        (
          await decay({
            results: files.map((file) => memoryEntry(file)),
            workspaceDir: dir,
            extraPaths: [{ path: "notes", pattern: "stable/**/*.md", evergreen: true }],
            memorySourceMtimes:
              mtimeSource === "indexed-host"
                ? new Map(files.map((file) => [file, NOW_MS - 30 * DAY_MS]))
                : undefined,
          })
        ).map((entry) => [entry.path, entry.score]),
      );

      expect(byPath.get("notes/stable/topic.md")).toBeCloseTo(1);
      expect(byPath.get("notes/dated/topic.md")).toBeCloseTo(0.5, 2);
    },
  );

  it.each([undefined, NOW_MS - 30 * DAY_MS])(
    "retains indexed session timestamp semantics (%s) under evergreen policy",
    async (mtime) => {
      const dir = await createTempWorkspace("openclaw-temporal-decay-");
      const entry = { path: "sessions/main/note.jsonl", score: 1, source: "sessions" };
      const [result] = await decay({
        results: [entry],
        workspaceDir: dir,
        extraPaths: [{ path: "sessions", evergreen: true }],
        sessionSourceMtimes: new Map(mtime === undefined ? [] : [[entry.path, mtime]]),
      });
      expect(result?.score).toBeCloseTo(mtime === undefined ? 1 : 0.5);
    },
  );
});
