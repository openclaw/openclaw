import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDreamCycle } from "./dream.js";
import { LogMemoryStore } from "./store.js";
import {
  makeFailingConsolidator,
  makeFakeEmbedder,
  makeStaticConsolidator,
  makeTempWorkspace,
} from "./test-helpers.js";
import type { LogMemoryEntry } from "./types.js";

const STALE_TS_BASE = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

function staleEntry(idx: number, content: string): LogMemoryEntry {
  // Spread timestamps slightly so each block has a unique computeEntryId.
  const ts = new Date(STALE_TS_BASE.getTime() + idx);
  return {
    id: `pre-${idx}`,
    timestamp: ts,
    layer: "episodic",
    payload: {
      type: "raw_log",
      content,
      tags: ["service:diagfw"],
      source: "log_ingest",
      decayScore: 0.05,
      accessCount: 0,
      lastAccessedAt: ts,
    },
  };
}

describe("runDreamCycle (file-backed)", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  async function seedStaleEpisodic(
    count: number,
    content = "probe stuck on diagfw",
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.appendEpisodic(staleEntry(i, `${content} ${i}`));
    }
  }

  it("skips when too few candidates", async () => {
    const result = await runDreamCycle({
      store,
      embed,
      consolidate: makeStaticConsolidator({
        title: "x",
        pattern: "y",
        rootCause: "z",
        tags: [],
      }),
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("insufficient_candidates");
  });

  it("consolidates clusters, appends KNOWLEDGE.md, marks episodic as consolidated", async () => {
    await seedStaleEpisodic(16);
    expect(await store.countByLayer("episodic")).toBe(16);

    const result = await runDreamCycle({
      store,
      embed,
      consolidate: makeStaticConsolidator({
        title: "Probe stuck pattern",
        pattern: "Repeated probe disconnects on diagfw.",
        rootCause: "Jig misalignment.",
        tags: ["error_pattern"],
      }),
      options: { trigger: "manual" },
    });

    expect(result.status).toBe("completed");
    expect(result.consumed).toBeGreaterThanOrEqual(3);
    expect(result.produced).toBeGreaterThanOrEqual(1);

    // Default count drops because consolidated entries are filtered out, but
    // the raw blocks are still on disk — non-destructive forgetting.
    expect(await store.countByLayer("episodic")).toBe(16 - result.consumed);
    const includingConsolidated = await store.loadEpisodic({ includeConsolidated: true });
    expect(includingConsolidated).toHaveLength(16);
    const consolidated = includingConsolidated.filter((e) => e.payload.consolidatedAt);
    expect(consolidated.length).toBe(result.consumed);

    const semanticEntries = await store.loadSemantic();
    expect(semanticEntries.length).toBe(result.produced);
    expect(semanticEntries[0].payload.source).toBe("dream_consolidation");
    expect(semanticEntries[0].payload.decayScore).toBe(0.9);

    const knowledge = await fs.readFile(store.semanticPath(), "utf8");
    expect(knowledge).toContain("Probe stuck pattern");
    expect(knowledge).toContain("Source: dream_consolidation");
  });

  it("a second dream cycle does not re-consolidate already-flagged entries", async () => {
    await seedStaleEpisodic(16);
    const consolidate = makeStaticConsolidator({
      title: "x",
      pattern: "y",
      rootCause: "z",
      tags: [],
    });
    await runDreamCycle({ store, embed, consolidate });
    const result = await runDreamCycle({ store, embed, consolidate });
    // No fresh candidates left — the second cycle should skip.
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("insufficient_candidates");
  });

  it("dry run leaves episodic intact", async () => {
    await seedStaleEpisodic(16);
    const result = await runDreamCycle({
      store,
      embed,
      consolidate: makeStaticConsolidator({
        title: "x",
        pattern: "y",
        rootCause: "z",
        tags: [],
      }),
      options: { dryRun: true },
    });
    expect(result.status).toBe("completed");
    expect(await store.countByLayer("episodic")).toBe(16);
  });

  it("skips clusters whose consolidator returns null", async () => {
    await seedStaleEpisodic(16);
    const result = await runDreamCycle({
      store,
      embed,
      consolidate: makeFailingConsolidator(),
    });
    expect(result.status).toBe("completed");
    expect(result.produced).toBe(0);
    expect(await store.countByLayer("episodic")).toBe(16);
  });
});
