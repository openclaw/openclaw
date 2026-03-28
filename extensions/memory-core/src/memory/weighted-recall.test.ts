import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWeightsToResults,
  WEIGHT_CORRECTION_NEW,
  WEIGHT_CORRECTION_ORIGINAL,
  WEIGHT_DEFAULT,
  WEIGHT_RECALL_INCREMENT,
  WeightedRecallStore,
} from "./weighted-recall.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-weighted-recall-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("WeightedRecallStore", () => {
  it("returns default weight for unknown chunk", async () => {
    const store = new WeightedRecallStore(tmpDir);
    expect(await store.getWeight("unknown-id")).toBe(WEIGHT_DEFAULT);
  });

  it("increments weight on recall", async () => {
    const store = new WeightedRecallStore(tmpDir);
    await store.recordRecall("chunk-1");
    expect(await store.getWeight("chunk-1")).toBeCloseTo(WEIGHT_DEFAULT + WEIGHT_RECALL_INCREMENT);
  });

  it("accumulates multiple recalls", async () => {
    const store = new WeightedRecallStore(tmpDir);
    await store.recordRecall("chunk-1");
    await store.recordRecall("chunk-1");
    await store.recordRecall("chunk-1");
    expect(await store.getWeight("chunk-1")).toBeCloseTo(
      WEIGHT_DEFAULT + WEIGHT_RECALL_INCREMENT * 3,
    );
  });

  it("clamps recall weight at MAX", async () => {
    const store = new WeightedRecallStore(tmpDir);
    // Recall 25 times — should not exceed 3.0
    for (let i = 0; i < 25; i++) {
      await store.recordRecall("chunk-1");
    }
    expect(await store.getWeight("chunk-1")).toBeLessThanOrEqual(3.0);
  });

  it("demotes original on correction", async () => {
    const store = new WeightedRecallStore(tmpDir);
    const newWeight = await store.recordCorrection("original-id");
    expect(await store.getWeight("original-id")).toBe(WEIGHT_CORRECTION_ORIGINAL);
    expect(newWeight).toBe(WEIGHT_CORRECTION_NEW);
  });

  it("persists weights across instances after flush", async () => {
    const store1 = new WeightedRecallStore(tmpDir);
    await store1.recordRecall("chunk-a");
    await store1.recordRecall("chunk-a");
    await store1.flush();

    const store2 = new WeightedRecallStore(tmpDir);
    expect(await store2.getWeight("chunk-a")).toBeCloseTo(
      WEIGHT_DEFAULT + WEIGHT_RECALL_INCREMENT * 2,
    );
  });

  it("does not write file when not dirty", async () => {
    const store = new WeightedRecallStore(tmpDir);
    await store.flush(); // nothing dirty yet
    const weightsPath = path.join(tmpDir, "memory-weights.json");
    await expect(fs.stat(weightsPath)).rejects.toThrow(); // file should not exist
  });

  it("handles missing weights file gracefully", async () => {
    const store = new WeightedRecallStore(path.join(tmpDir, "does-not-exist"));
    expect(await store.getWeight("any")).toBe(WEIGHT_DEFAULT);
  });
});

describe("applyWeightsToResults", () => {
  it("returns results unchanged when all weights are default", async () => {
    const store = new WeightedRecallStore(tmpDir);
    const results = [
      { id: "a", score: 0.9, path: "p", source: "memory", snippet: "" },
      { id: "b", score: 0.7, path: "p", source: "memory", snippet: "" },
    ];
    const weighted = await applyWeightsToResults(results, store);
    expect(weighted[0].score).toBe(0.9);
    expect(weighted[1].score).toBe(0.7);
  });

  it("boosts score of recalled chunk", async () => {
    const store = new WeightedRecallStore(tmpDir);
    await store.recordRecall("a");
    const results = [
      { id: "a", score: 0.5, path: "p", source: "memory", snippet: "" },
      { id: "b", score: 0.9, path: "p", source: "memory", snippet: "" },
    ];
    const weighted = await applyWeightsToResults(results, store);
    // chunk-a score should increase
    expect(weighted[0].score).toBeGreaterThan(0.5);
    // chunk-b score unchanged
    expect(weighted[1].score).toBe(0.9);
  });

  it("demotes score of corrected chunk", async () => {
    const store = new WeightedRecallStore(tmpDir);
    await store.recordCorrection("stale-id");
    const results = [{ id: "stale-id", score: 0.8, path: "p", source: "memory", snippet: "" }];
    const weighted = await applyWeightsToResults(results, store);
    expect(weighted[0].score).toBeLessThan(0.8);
    expect(weighted[0].score).toBeCloseTo(0.8 * WEIGHT_CORRECTION_ORIGINAL);
  });

  it("returns empty array unchanged", async () => {
    const store = new WeightedRecallStore(tmpDir);
    expect(await applyWeightsToResults([], store)).toEqual([]);
  });
});
