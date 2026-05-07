import { describe, expect, it } from "vitest";
import { greedyClusterByCosine } from "./cluster.js";
import type { LogMemoryEntry } from "./types.js";

function entryWith(id: string, vec: number[]): LogMemoryEntry {
  const now = new Date();
  return {
    id,
    timestamp: now,
    layer: "episodic",
    embedding: new Float32Array(vec),
    payload: {
      type: "raw_log",
      content: id,
      tags: [],
      source: "log_ingest",
      decayScore: 0.1,
      accessCount: 0,
      lastAccessedAt: now,
    },
  };
}

describe("greedyClusterByCosine", () => {
  it("groups close vectors and drops too-small clusters", () => {
    const entries = [
      entryWith("a1", [1, 0, 0]),
      entryWith("a2", [0.99, 0.05, 0]),
      entryWith("a3", [0.98, -0.02, 0.01]),
      entryWith("b1", [0, 1, 0]),
      entryWith("b2", [0, 0.99, 0.05]),
    ];
    const clusters = greedyClusterByCosine(entries, { threshold: 0.9, minClusterSize: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id).toSorted()).toEqual(["a1", "a2", "a3"]);
  });

  it("skips entries without embeddings", () => {
    const now = new Date();
    const noEmbedding: LogMemoryEntry = {
      id: "x",
      timestamp: now,
      layer: "episodic",
      payload: {
        type: "raw_log",
        content: "",
        tags: [],
        source: "log_ingest",
        decayScore: 0,
        accessCount: 0,
        lastAccessedAt: now,
      },
    };
    const clusters = greedyClusterByCosine(
      [
        noEmbedding,
        entryWith("a1", [1, 0]),
        entryWith("a2", [0.99, 0.01]),
        entryWith("a3", [0.98, 0]),
      ],
      { threshold: 0.9, minClusterSize: 3 },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id).toSorted()).toEqual(["a1", "a2", "a3"]);
  });
});
