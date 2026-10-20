import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { mergeHybridResults } from "./hybrid.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 1, 10, 0, 0, 0);
const { createTempWorkspace } = createMemoryCoreTestHarness();

function createVectorMemoryEntry(memoryPath: string, vectorScore: number) {
  return {
    id: memoryPath,
    path: memoryPath,
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: "memory",
    vectorScore,
  };
}

describe("temporal decay", () => {
  it("uses indexed remote mtimes in hybrid ranking while retaining evergreen and dated paths", async () => {
    const paths = ["imports/note.md", "MEMORY.md", "memory/2026-02-09.md"];
    const results = await mergeHybridResults({
      vector: paths.map((filePath) => ({
        ...createVectorMemoryEntry(filePath, 1),
        snippet: "host content",
      })),
      keyword: [],
      vectorWeight: 1,
      textWeight: 0,
      mmr: { enabled: false, lambda: 0.7 },
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
      memorySourceMtimes: new Map(paths.map((filePath) => [filePath, NOW_MS - 30 * DAY_MS])),
    });
    expect(results.find((entry) => entry.path === "imports/note.md")?.score).toBeCloseTo(0.5);
    expect(results.find((entry) => entry.path === "MEMORY.md")?.score).toBe(1);
    expect(results.find((entry) => entry.path === "memory/2026-02-09.md")?.score).toBeGreaterThan(
      0.9,
    );
  });

  it("uses file mtime for additional memory files", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");
    const filePath = path.join(dir, "notes", "topic.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "notes\n");
    const oldMtime = new Date(NOW_MS - 30 * DAY_MS);
    await fs.utimes(filePath, oldMtime, oldMtime);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [{ path: "notes/topic.md", score: 1, source: "memory" }],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });

  it("keeps explicitly evergreen extra-path references out of mtime decay", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");
    const referencePath = path.join(dir, "reference", "topic.md");
    await fs.mkdir(path.dirname(referencePath), { recursive: true });
    await fs.writeFile(referencePath, "stable reference\n");
    const oldMtime = new Date(NOW_MS - 300 * DAY_MS);
    await fs.utimes(referencePath, oldMtime, oldMtime);

    const decayed = await applyTemporalDecayToHybridResults({
      results: [{ path: "reference/topic.md", score: 0.8, source: "memory" }],
      workspaceDir: dir,
      extraPaths: [{ path: "reference", evergreen: true }],
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(0.8);
  });

  it.each(["local", "indexed-host"] as const)(
    "applies evergreen only to matching files with %s timestamps",
    async (mtimeSource) => {
      const dir = await createTempWorkspace("openclaw-temporal-decay-");
      const stablePath = path.join(dir, "notes", "stable", "topic.md");
      const datedPath = path.join(dir, "notes", "dated", "topic.md");
      await fs.mkdir(path.dirname(stablePath), { recursive: true });
      await fs.mkdir(path.dirname(datedPath), { recursive: true });
      await fs.writeFile(stablePath, "stable reference\n");
      await fs.writeFile(datedPath, "dated note\n");
      // Indexed host timestamps must win over the gateway filesystem.
      const oldMtime = new Date(mtimeSource === "local" ? NOW_MS - 30 * DAY_MS : NOW_MS);
      await Promise.all([
        fs.utimes(stablePath, oldMtime, oldMtime),
        fs.utimes(datedPath, oldMtime, oldMtime),
      ]);

      const byPath = new Map(
        (
          await applyTemporalDecayToHybridResults({
            results: [
              { path: "notes/stable/topic.md", score: 1, source: "memory" },
              { path: "notes/dated/topic.md", score: 1, source: "memory" },
            ],
            workspaceDir: dir,
            extraPaths: [{ path: "notes", pattern: "stable/**/*.md", evergreen: true }],
            memorySourceMtimes:
              mtimeSource === "indexed-host"
                ? new Map([
                    ["notes/stable/topic.md", NOW_MS - 30 * DAY_MS],
                    ["notes/dated/topic.md", NOW_MS - 30 * DAY_MS],
                  ])
                : undefined,
            temporalDecay: { enabled: true, halfLifeDays: 30 },
            nowMs: NOW_MS,
          })
        ).map((entry) => [entry.path, entry.score]),
      );

      expect(byPath.get("notes/stable/topic.md")).toBeCloseTo(1);
      expect(byPath.get("notes/dated/topic.md")).toBeCloseTo(0.5, 2);
    },
  );

  it.each(["relative", "absolute"] as const)(
    "does not let extra-path policy override %s dated canonical memory",
    async (pathKind) => {
      const dir = await createTempWorkspace("openclaw-temporal-decay-");
      const dailyPath = path.join(dir, "memory", "2026-01-11.md");
      await fs.mkdir(path.dirname(dailyPath), { recursive: true });
      await fs.writeFile(dailyPath, "daily note\n");

      const decayed = await applyTemporalDecayToHybridResults({
        results: [
          {
            path: pathKind === "absolute" ? dailyPath : "memory/2026-01-11.md",
            score: 1,
            source: "memory",
          },
        ],
        workspaceDir: dir,
        extraPaths: [{ path: "memory", evergreen: true }],
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        nowMs: NOW_MS,
      });

      expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
    },
  );

  it.each([undefined, NOW_MS - 30 * DAY_MS])(
    "retains indexed session timestamp semantics (%s) under evergreen policy",
    async (mtime) => {
      const dir = await createTempWorkspace("openclaw-temporal-decay-");
      const entry = { path: "sessions/main/note.jsonl", score: 1, source: "sessions" };
      const [result] = await applyTemporalDecayToHybridResults({
        results: [entry],
        workspaceDir: dir,
        extraPaths: [{ path: "sessions", evergreen: true }],
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        sessionSourceMtimes: new Map(mtime === undefined ? [] : [[entry.path, mtime]]),
        nowMs: NOW_MS,
      });
      expect(result?.score).toBeCloseTo(mtime === undefined ? 1 : 0.5);
    },
  );
});
