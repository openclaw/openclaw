import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";
import type { LogMemoryEntry } from "./types.js";

function makeEntry(id: string, content: string, embedding: Float32Array): LogMemoryEntry {
  const now = new Date();
  return {
    id,
    timestamp: now,
    layer: "episodic",
    embedding,
    payload: {
      type: "raw_log",
      content,
      tags: ["service:diagfw", "level:ERROR"],
      source: "log_ingest",
      decayScore: 1,
      accessCount: 0,
      lastAccessedAt: now,
    },
  };
}

describe("LogMemoryStore", () => {
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

  it("persists, dedupes, deletes", async () => {
    const [vec] = await embed(["probe failed"]);
    store.upsert(makeEntry("id-1", "probe failed", vec));
    expect(store.has("id-1")).toBe(true);
    expect(store.countByLayer("episodic")).toBe(1);
    store.upsert(makeEntry("id-1", "probe failed v2", vec));
    expect(store.countByLayer("episodic")).toBe(1);
    expect(store.delete(["id-1"])).toBe(1);
    expect(store.has("id-1")).toBe(false);
  });

  it("hybrid search blends bm25 and cosine", async () => {
    const [vec1, vec2, vecQuery] = await embed([
      "probe stuck on diagfw",
      "unrelated network ping",
      "probe stuck",
    ]);
    store.upsert(makeEntry("e1", "probe stuck on diagfw", vec1));
    store.upsert(makeEntry("e2", "unrelated network ping", vec2));
    const results = await store.hybridSearch({
      queryText: "probe stuck",
      queryEmbedding: vecQuery,
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe("e1");
    // Score combines vector and bm25.
    expect(results[0].score).toBeCloseTo(
      0.6 * results[0].vectorScore + 0.4 * results[0].bm25Score,
      6,
    );
  });

  it("filters by layer and tags", async () => {
    const [vec] = await embed(["fan stalled"]);
    const semanticEntry = makeEntry("s1", "fan stalled", vec);
    semanticEntry.layer = "semantic";
    semanticEntry.payload.tags = ["service:cooler"];
    store.upsert(semanticEntry);
    store.upsert(makeEntry("e1", "fan stalled", vec));

    const onlySemantic = await store.hybridSearch({
      queryText: "fan stalled",
      queryEmbedding: vec,
      layer: "semantic",
    });
    expect(onlySemantic.map((r) => r.entry.id)).toEqual(["s1"]);

    const onlyCooler = await store.hybridSearch({
      queryText: "fan stalled",
      queryEmbedding: vec,
      tags: ["service:cooler"],
    });
    expect(onlyCooler.map((r) => r.entry.id)).toEqual(["s1"]);
  });

  it("records access count and dream records", () => {
    const dream = {
      dreamId: "d-1",
      triggeredAt: new Date(),
      trigger: "manual" as const,
      episodicConsumed: 5,
      semanticProduced: 1,
      durationMs: 120,
    };
    store.insertDreamRecord(dream);
    const records = store.listDreamRecords();
    expect(records).toHaveLength(1);
    expect(records[0].dreamId).toBe("d-1");
  });

  it("selectDreamCandidates filters by dynamic decay", async () => {
    const [vec] = await embed(["x"]);
    const oldTs = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    store.upsert({
      id: "old-1",
      timestamp: oldTs,
      layer: "episodic",
      embedding: vec,
      payload: {
        type: "raw_log",
        content: "x",
        tags: [],
        source: "log_ingest",
        decayScore: 0.05,
        accessCount: 0,
        lastAccessedAt: oldTs,
      },
    });
    store.upsert({
      id: "fresh-1",
      timestamp: new Date(),
      layer: "episodic",
      embedding: vec,
      payload: {
        type: "raw_log",
        content: "x",
        tags: [],
        source: "log_ingest",
        decayScore: 1.0,
        accessCount: 0,
        lastAccessedAt: new Date(),
      },
    });
    const candidates = store.selectDreamCandidates({
      threshold: 0.25,
      limit: 100,
      now: new Date(),
    });
    expect(candidates.map((c) => c.id)).toEqual(["old-1"]);
  });
});
