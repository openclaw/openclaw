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

const STALE_TS = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

function staleEntry(id: string, vec: Float32Array, content: string): LogMemoryEntry {
  return {
    id,
    timestamp: STALE_TS,
    layer: "episodic",
    embedding: vec,
    payload: {
      type: "raw_log",
      content,
      tags: ["service:diagfw"],
      source: "log_ingest",
      decayScore: 0.05,
      accessCount: 0,
      lastAccessedAt: STALE_TS,
    },
  };
}

describe("runDreamCycle", () => {
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

  it("consolidates clusters and prunes episodic by default", async () => {
    const messages = Array.from({ length: 16 }, (_, i) => `probe stuck on diagfw ${i}`);
    const vectors = await embed(messages);
    for (let i = 0; i < messages.length; i++) {
      store.upsert(staleEntry(`e-${i}`, vectors[i], messages[i]));
    }
    expect(store.countByLayer("episodic")).toBe(16);

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
    expect(store.countByLayer("episodic")).toBe(16 - result.consumed);
    const semantic = store.listByLayer("semantic");
    expect(semantic.length).toBe(result.produced);
    expect(semantic[0].payload.source).toBe("dream_consolidation");
    expect(semantic[0].payload.decayScore).toBe(0.9);

    const records = store.listDreamRecords();
    expect(records).toHaveLength(1);
    expect(records[0].trigger).toBe("manual");
    expect(records[0].episodicConsumed).toBe(result.consumed);
  });

  it("dry run leaves episodic intact", async () => {
    const messages = Array.from({ length: 16 }, (_, i) => `probe stuck on diagfw ${i}`);
    const vectors = await embed(messages);
    for (let i = 0; i < messages.length; i++) {
      store.upsert(staleEntry(`e-${i}`, vectors[i], messages[i]));
    }
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
    expect(store.countByLayer("episodic")).toBe(16);
  });

  it("skips clusters whose consolidator returns null", async () => {
    const messages = Array.from({ length: 16 }, (_, i) => `probe stuck on diagfw ${i}`);
    const vectors = await embed(messages);
    for (let i = 0; i < messages.length; i++) {
      store.upsert(staleEntry(`e-${i}`, vectors[i], messages[i]));
    }
    const result = await runDreamCycle({
      store,
      embed,
      consolidate: makeFailingConsolidator(),
    });
    expect(result.status).toBe("completed");
    expect(result.produced).toBe(0);
    // Nothing was consolidated, so nothing was consumed.
    expect(store.countByLayer("episodic")).toBe(16);
  });
});
