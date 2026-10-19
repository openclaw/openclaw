import fs from "node:fs/promises";
import path from "node:path";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
  readMemoryHostEvents,
} from "openclaw/plugin-sdk/memory-host-events";
import { describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function writeNote(workspaceDir: string, relativePath: string, content: string) {
  const target = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function recall(relativePath: string, snippet: string, score: number, endLine = 3) {
  return { path: relativePath, snippet, score, startLine: 3, endLine, source: "memory" as const };
}

const permissivePromotion = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };

describe("memory host event journal integration", () => {
  it("records recall and promotion events from short-term promotion flows", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-events-");
    await writeNote(workspaceDir, "memory/2026-04-05.md", "# Daily\n\nalpha\nbeta\ngamma\n");

    await recordShortTermRecalls({
      workspaceDir,
      query: "alpha memory",
      results: [recall("memory/2026-04-05.md", "alpha beta", 0.92, 4)],
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      ...permissivePromotion,
      nowMs: Date.UTC(2026, 3, 5, 12, 5, 0),
    });
    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates,
      ...permissivePromotion,
      nowMs: Date.UTC(2026, 3, 5, 12, 10, 0),
    });

    expect(applied.applied).toBe(1);

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(events).toMatchObject([
      { type: "memory.recall.recorded", resultCount: 1, query: "alpha memory" },
      { type: "memory.promotion.applied", applied: 1 },
    ]);
  });

  it("records skipped recall events for durable memory hits excluded from short-term promotion", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-skipped-recall-events-");
    const results = [
      recall("MEMORY.md", "Alpha durable note.", 0.91),
      recall("memory/decisoes/2026-06.md", "Alpha monthly decision.", 0.88),
      recall("memory/idiomas/PLANO.md", "Alpha language plan.", 0.83),
    ];
    for (const result of results) {
      await writeNote(workspaceDir, result.path, `# Memory\n\n${result.snippet}\n`);
    }

    await recordShortTermRecalls({
      workspaceDir,
      query: "alpha durable memory",
      results,
      nowMs: Date.UTC(2026, 5, 13, 9, 0, 0),
    });

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      ...permissivePromotion,
      nowMs: Date.UTC(2026, 5, 13, 9, 5, 0),
    });
    const events = await readMemoryHostEventRecords({ workspaceDir });

    expect(candidates).toEqual([]);
    expect(events).toMatchObject([
      {
        type: "memory.recall.skipped",
        query: "alpha durable memory",
        reason: "non-short-term-memory-path",
        eligibleResultCount: 0,
        skippedResultCount: 3,
        results: results.map(({ path: sourcePath }) => ({
          path: sourcePath,
          reason: "non-short-term-memory-path",
        })),
      },
    ]);
  });

  it("records dreaming completion events when phase artifacts are written", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-dream-events-");

    const written = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- staged note", "- second note"],
      hasContent: true,
      nowMs: Date.UTC(2026, 3, 5, 13, 0, 0),
      storage: { mode: "both", separateReports: true },
    });

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(written.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    expect(written.reportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
    );
    await expect(fs.readFile(written.inlinePath ?? "", "utf8")).resolves.toContain("- staged note");
    await expect(fs.readFile(written.reportPath ?? "", "utf8")).resolves.toContain("- second note");
    expect(events).toMatchObject([
      {
        type: "memory.dream.completed",
        phase: "light",
        outcome: "completed",
        lineCount: 2,
        storageMode: "both",
      },
    ]);
  });

  it("keeps legacy dreaming completion events without outcome readable", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-legacy-dream-events-");
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.dream.completed",
      timestamp: "2026-04-05T13:00:00.000Z",
      phase: "deep",
      inlinePath: path.join(workspaceDir, "DREAMS.md"),
      lineCount: 2,
      storageMode: "inline",
    });

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(events).toMatchObject([{ type: "memory.dream.completed", phase: "deep" }]);
    const event = events[0];
    if (event?.type !== "memory.dream.completed") {
      throw new Error("expected dream completion event");
    }
    expect(event.outcome).toBeUndefined();
  });
});
