import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DreamScheduler } from "./scheduler.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeStaticConsolidator, makeTempWorkspace } from "./test-helpers.js";
import type { LogMemoryEntry } from "./types.js";

const STALE_TS_BASE = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

function staleEntry(idx: number, content: string): LogMemoryEntry {
  const ts = new Date(STALE_TS_BASE.getTime() + idx);
  return {
    id: `pre-${idx}`,
    timestamp: ts,
    layer: "episodic",
    payload: {
      type: "raw_log",
      content,
      tags: [],
      source: "log_ingest",
      decayScore: 0.05,
      accessCount: 0,
      lastAccessedAt: ts,
    },
  };
}

describe("DreamScheduler (file-backed)", () => {
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

  it("tick skips when below minEpisodicCount", async () => {
    const scheduler = new DreamScheduler({
      store,
      embed,
      consolidate: makeStaticConsolidator({
        title: "x",
        pattern: "y",
        rootCause: "z",
        tags: [],
      }),
      minEpisodicCount: 50,
    });
    expect(await scheduler.tick()).toBeNull();
  });

  it("tick runs the dream cycle when above the threshold", async () => {
    for (let i = 0; i < 16; i++) {
      await store.appendEpisodic(staleEntry(i, `probe stuck on diagfw ${i}`));
    }
    const scheduler = new DreamScheduler({
      store,
      embed,
      consolidate: makeStaticConsolidator({
        title: "x",
        pattern: "y",
        rootCause: "z",
        tags: [],
      }),
      minEpisodicCount: 5,
    });
    const result = await scheduler.tick();
    expect(result?.status).toBe("completed");
    expect(result?.dreamRecord?.trigger).toBe("cron");
  });
});
