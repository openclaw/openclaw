import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EpisodicStore } from "./store.js";
import type { SelfEvolveConfig } from "./types.js";

function makeConfig(): SelfEvolveConfig {
  return {
    embedding: { provider: "hash", model: "x", dimensions: 3 },
    retrieval: { k1: 5, k2: 3, delta: 0.2, tau: 0, lambda: 0.5, epsilon: 0 },
    learning: { alpha: 0.3, gamma: 0, qInit: 0, rewardSuccess: 1, rewardFailure: -1 },
    memory: { maxEntries: 3, maxExperienceChars: 1000, includeFailures: true },
    reward: { provider: "openai", model: "gpt-4.1-mini", temperature: 0 },
    runtime: {
      minPromptChars: 6,
      observeTurns: 0,
      minAbsReward: 0,
      minRewardConfidence: 0,
      learnMode: "balanced",
      noToolMinAbsReward: 0.8,
      noToolMinRewardConfidence: 0.9,
      newIntentSimilarityThreshold: 0.35,
      idleTurnsToClose: 2,
      pendingTtlMs: 900000,
      maxTurnsPerTask: 10,
    },
    experience: {
      summarizer: "openai",
      model: "gpt-4.1-mini",
      temperature: 0,
      maxToolEvents: 6,
      maxRawChars: 1200,
      maxSummaryChars: 500,
    },
  };
}

describe("EpisodicStore", () => {
  it("searches by similarity and applies phase-a threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "self-evolve-store-"));
    const filePath = join(dir, "state.json");
    const store = new EpisodicStore(filePath);
    store.add({
      intent: "a",
      experience: "a",
      embedding: [1, 0, 0],
      qInit: 0,
      maxEntries: 10,
    });
    store.add({
      intent: "b",
      experience: "b",
      embedding: [0, 1, 0],
      qInit: 0,
      maxEntries: 10,
    });
    const matches = store.search([0.9, 0.1, 0], makeConfig());
    expect(matches.length).toBe(1);
    expect(matches[0]?.triplet.intent).toBe("a");
  });

  it("updates q-values via td update and persists to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "self-evolve-store-"));
    const filePath = join(dir, "state.json");
    const store = new EpisodicStore(filePath);
    const entry = store.add({
      intent: "a",
      experience: "a",
      embedding: [1, 0],
      qInit: 0,
      maxEntries: 10,
    });
    store.updateQ({
      memoryIds: [entry.id],
      reward: 1,
      alpha: 0.5,
      gamma: 0,
    });
    await store.save();

    const reloaded = new EpisodicStore(filePath);
    await reloaded.load();
    const loaded = reloaded.list().find((item) => item.id === entry.id);
    expect(loaded?.qValue).toBe(0.5);
    expect(loaded?.visits).toBe(1);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Array<{ id: string; qValue: number }>;
    };
    expect(persisted.entries.some((item) => item.id === entry.id && item.qValue === 0.5)).toBe(
      true,
    );
  });

  it("enforces max entries limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "self-evolve-store-"));
    const filePath = join(dir, "state.json");
    const store = new EpisodicStore(filePath);
    store.add({ intent: "1", experience: "1", embedding: [1, 0], qInit: 0, maxEntries: 2 });
    store.add({ intent: "2", experience: "2", embedding: [0, 1], qInit: 0, maxEntries: 2 });
    store.add({ intent: "3", experience: "3", embedding: [-1, 0], qInit: 0, maxEntries: 2 });
    expect(store.list().length).toBe(2);
  });
});
