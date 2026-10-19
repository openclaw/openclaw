import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi, type MockInstance } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as reindexLock from "./manager-reindex-lock.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const embeddings = await import("./embeddings.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });

it("does not write stale-provider chunks after a queued legacy upgrade loses its publication", async () => {
  const oldModel = "original-embedding";
  const canonicalIdentity = { provider: "mock", model: oldModel };
  const legacyIdentity = { ...canonicalIdentity, legacyAuthHeader: "synthetic" };
  const createProvider = embeddings.createEmbeddingProvider;
  const provider = vi
    .spyOn(embeddings, "createEmbeddingProvider")
    .mockImplementation(async (...args) => {
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
  const oldConfig = fixture.createConfig({
    provider: "openai",
    fallback: "none",
    model: oldModel,
    vectorEnabled: false,
    cacheEnabled: true,
  });
  const replacementConfig = fixture.createConfig({
    provider: "openai",
    fallback: "none",
    model: "replacement-embedding",
    vectorEnabled: false,
    cacheEnabled: true,
  });
  const replacementEntered = createDeferred<void>();
  const releaseReplacement = createDeferred<void>();
  const staleWaiting = createDeferred<void>();
  const releaseStale = createDeferred<void>();
  let lock: MockInstance<typeof reindexLock.waitForMemoryReindexLock> | undefined;
  let replacementSync: Promise<void> | undefined;
  let staleSync: Promise<void> | undefined;
  try {
    const seeded = await fixture.getFreshManager(oldConfig, "cli");
    await seeded.sync({ reason: "test", force: true });
    const dbPath = seeded.status().dbPath;
    if (!dbPath) {
      throw new Error("fixture memory database is unavailable");
    }
    await seeded.close();
    await closeAllMemorySearchManagers();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const seed = new DatabaseSync(dbPath);
    try {
      const row = seed
        .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
        .get("memory_index_meta_v1");
      if (typeof row?.value !== "string") {
        throw new Error("fixture memory metadata is unavailable");
      }
      const meta = JSON.parse(row.value) as MemoryIndexMeta;
      const providerKey = hashText(JSON.stringify(legacyIdentity));
      seed
        .prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?")
        .run(JSON.stringify({ ...meta, providerKey }), "memory_index_meta_v1");
      seed.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(providerKey);
    } finally {
      seed.close();
    }

    const stale = await fixture.getFreshManager(oldConfig, "cli");
    const replacement = await fixture.getFreshManager(replacementConfig, "cli");
    const note = path.join(fixture.paths.memory, "2026-01-12.md");
    await fs.writeFile(note, "The replacement provider owns this published note.");
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
    expect(published).toEqual([
      expect.objectContaining({
        model: "replacement-embedding",
        text: "The replacement provider owns this published note.",
      }),
    ]);

    await fs.writeFile(note, "A stale writer must not embed this changed note.");
    releaseStale.resolve();
    await staleSync;
    expect(rows()).toEqual(published);
    expect(fixture.provider.embeddedBatchTexts).not.toContain(
      "A stale writer must not embed this changed note.",
    );
  } finally {
    releaseReplacement.resolve();
    releaseStale.resolve();
    await Promise.allSettled([replacementSync, staleSync]);
    lock?.mockRestore();
    provider.mockRestore();
  }
});
