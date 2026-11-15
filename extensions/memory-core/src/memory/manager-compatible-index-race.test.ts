import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type MockInstance } from "vitest";
import {
  closeCompatibleIndexManagers,
  seedLegacyMemoryIndex,
} from "./manager-compatible-index.test-support.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as reindexLock from "./manager-reindex-lock.js";

const embeddings = await import("./embeddings.js");
const fixture = createManagerIndexFixture(await import("./index.js"));

it("does not write stale-provider chunks after a queued legacy upgrade loses its publication", async () => {
  const oldModel = "original-embedding";
  const canonicalIdentity = { provider: "mock", model: oldModel };
  const legacyIdentity = { ...canonicalIdentity, legacyAuthHeader: "synthetic" };
  const createProvider = embeddings.createEmbeddingProvider;
  const provider = vi.spyOn(embeddings, "createEmbeddingProvider");
  provider.mockImplementation(async (...args) => {
    const result = await createProvider(...args);
    return result.provider?.model === oldModel
      ? {
          ...result,
          runtime: {
            id: result.provider.id,
            cacheKeyData: canonicalIdentity,
            indexIdentityAliases: [{ model: oldModel, cacheKeyData: legacyIdentity }],
          },
        }
      : result;
  });
  const options = {
    provider: "openai",
    fallback: "none",
    vectorEnabled: false,
    cacheEnabled: true,
  } as const;
  const open = (model: string) =>
    fixture.getFreshManager(fixture.createConfig({ ...options, model }), "cli");
  const replacementEntered = createDeferred<void>();
  const releaseReplacement = createDeferred<void>();
  const staleWaiting = createDeferred<void>();
  const releaseStale = createDeferred<void>();
  let lock: MockInstance<typeof reindexLock.waitForMemoryReindexLock> | undefined;
  let replacementSync: Promise<void> | undefined;
  let staleSync: Promise<void> | undefined;
  try {
    const seeded = await open(oldModel);
    await seeded.sync({ reason: "test", force: true });
    const dbPath = seeded.status().dbPath;
    assert(dbPath, "fixture memory database is unavailable");
    await seeded.close();
    await closeCompatibleIndexManagers();
    seedLegacyMemoryIndex(dbPath, legacyIdentity);

    const stale = await open(oldModel);
    const replacement = await open("replacement-embedding");
    const note = path.join(fixture.paths.memory, "2026-01-12.md");
    const replacementText = "The replacement provider owns this published note.";
    const staleText = "A stale writer must not embed this changed note.";
    await fs.writeFile(note, replacementText);
    fixture.provider.beforeEmbedBatch = async () => {
      replacementEntered.resolve();
      await releaseReplacement.promise;
    };
    replacementSync = replacement.sync({ reason: "test", force: true });
    await Promise.race([replacementEntered.promise, replacementSync]);
    fixture.provider.beforeEmbedBatch = null;

    const acquire = reindexLock.waitForMemoryReindexLock;
    lock = vi.spyOn(reindexLock, "waitForMemoryReindexLock").mockImplementation(async (...args) => {
      staleWaiting.resolve();
      const held = await acquire(...args);
      await releaseStale.promise;
      return held;
    });
    staleSync = stale.sync({ reason: "search-bootstrap" });
    await Promise.race([staleWaiting.promise, staleSync]);
    releaseReplacement.resolve();
    await replacementSync;
    const writer = memoryIndexFixtureWriter(replacement);
    const rows = () =>
      writer.prepare("SELECT model, text, embedding FROM memory_index_chunks ORDER BY id").all();
    const published = rows();
    expect(published).toMatchObject([{ model: "replacement-embedding", text: replacementText }]);

    await fs.writeFile(note, staleText);
    releaseStale.resolve();
    await staleSync;
    expect(rows()).toEqual(published);
    expect(fixture.provider.embeddedBatchTexts).not.toContain(staleText);
  } finally {
    releaseReplacement.resolve();
    releaseStale.resolve();
    await Promise.allSettled([replacementSync, staleSync]);
    lock?.mockRestore();
    provider.mockRestore();
  }
});
