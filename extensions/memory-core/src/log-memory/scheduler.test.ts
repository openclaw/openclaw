import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DreamScheduler } from "./scheduler.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeStaticConsolidator, makeTempWorkspace } from "./test-helpers.js";

const STALE_TS = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

describe("DreamScheduler", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    store.close();
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
    const result = await scheduler.tick();
    expect(result).toBeNull();
  });

  it("tick runs cycle when above threshold", async () => {
    const messages = Array.from({ length: 16 }, (_, i) => `probe stuck on diagfw ${i}`);
    const vectors = await embed(messages);
    for (let i = 0; i < messages.length; i++) {
      store.upsert({
        id: `e-${i}`,
        timestamp: STALE_TS,
        layer: "episodic",
        embedding: vectors[i],
        payload: {
          type: "raw_log",
          content: messages[i],
          tags: [],
          source: "log_ingest",
          decayScore: 0.05,
          accessCount: 0,
          lastAccessedAt: STALE_TS,
        },
      });
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
