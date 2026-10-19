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

  it("leaves session timestamps unknown when their indexed source is missing", async () => {
    const entry = { path: "sessions/main/missing.jsonl", score: 1, source: "sessions" };
    expect(
      await applyTemporalDecayToHybridResults({
        results: [entry],
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        sessionSourceMtimes: new Map(),
        nowMs: NOW_MS,
      }),
    ).toEqual([entry]);
  });
});
