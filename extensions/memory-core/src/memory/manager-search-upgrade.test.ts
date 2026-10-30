import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
  hashText,
  MEMORY_CHUNKING_VERSION,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION, type MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const embeddings = await import("./embeddings.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
const provider = fixture.provider;
const createConfig = (model = "mock-embed") =>
  fixture.createConfig({ model, vectorEnabled: false });
const alphaResult = expect.arrayContaining([
  expect.objectContaining({ path: "memory/2026-01-12.md" }),
]);
const versionKeys = ["chunkingVersion", "provenanceVersion"] as const;
const versions = {
  chunkingVersion: MEMORY_CHUNKING_VERSION,
  provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
};
type VersionKey = keyof typeof versions;
async function closeManager(manager: Awaited<ReturnType<typeof fixture.getFreshManager>>) {
  await manager.close();
  await closeAllMemorySearchManagers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
function withDatabase<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
function readMeta(db: DatabaseSync): MemoryIndexMeta {
  const value = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
    .get()?.value;
  if (typeof value !== "string") {
    throw new Error("fixture index metadata is missing");
  }
  return JSON.parse(value) as MemoryIndexMeta;
}
function updateMeta(db: DatabaseSync, meta: MemoryIndexMeta) {
  db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
    JSON.stringify(meta),
  );
}
async function publishIndex(
  cfg: ReturnType<typeof createConfig>,
  versionKey?: VersionKey,
  offset = -1,
): Promise<string> {
  const manager = await fixture.getFreshManager(cfg);
  await manager.sync({ reason: "test", force: true });
  const dbPath = manager.status().dbPath;
  if (!dbPath) {
    throw new Error("fixture database path is missing");
  }
  await closeManager(manager);
  if (versionKey) {
    withDatabase(dbPath, (db) =>
      updateMeta(db, { ...readMeta(db), [versionKey]: versions[versionKey] + offset }),
    );
  }
  return dbPath;
}
it("rebuilds unchanged prior-version content on the first default search", async () => {
  const cfg = createConfig();
  const dbPath = await publishIndex(cfg, "chunkingVersion");
  const manager = await fixture.getFreshManager(cfg, "default");
  expect(await manager.search("alpha", { lexicalOnly: true })).toEqual(alphaResult);
  expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION);
  await closeManager(manager);
  const publication = () =>
    withDatabase(dbPath, (db) => ({
      meta: readMeta(db),
      revision: db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
    }));
  const rebuilt = publication();
  const embedded = provider.embedBatchCalls;
  const reopened = await fixture.getFreshManager(cfg, "default");
  await reopened.sync({ reason: "watch" });
  expect(await reopened.search("alpha", { lexicalOnly: true })).not.toEqual([]);
  expect(provider.embedBatchCalls).toBe(embedded);
  expect(publication()).toEqual(rebuilt);
});

it("keeps status inspection read-only during an upgrade", async () => {
  const cfg = createConfig();
  const dbPath = await publishIndex(cfg, "chunkingVersion");
  const manager = await fixture.getFreshManager(cfg, "status");
  expect(manager.status().custom?.indexIdentity).toMatchObject({
    status: "mismatched",
    code: "chunking_version",
    owner: "openclaw",
  });
  expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
});

it.each(versionKeys)("preserves newer %s indexes until explicit reindex", async (versionKey) => {
  const cfg = createConfig();
  const dbPath = await publishIndex(cfg, versionKey, 1);
  const manager = await fixture.getFreshManager(cfg);
  const embedded = provider.embedBatchCalls;
  await manager.sync({ reason: "search", force: true });
  expect(await manager.search("alpha", { lexicalOnly: true })).toEqual([]);
  expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(versions[versionKey] + 1);
  expect(provider.embedBatchCalls).toBe(embedded);
  await manager.sync({ reason: "cli", force: true });
  expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
  expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(versions[versionKey]);
});

it.each(versionKeys)("serves compatible rows after failed %s rebuild", async (versionKey) => {
  const cfg = createConfig();
  const dbPath = await publishIndex(cfg, versionKey);
  await fs.writeFile(
    path.join(fixture.paths.memory, "2026-01-12.md"),
    "# Log\nAlpha memory line changed after the prior publication.",
  );
  provider.embedBatchPermanentFailure = new Error("embedding migration unavailable");
  const manager = await fixture.getFreshManager(cfg);
  const results = await manager.search("alpha", { lexicalOnly: true });
  expect(results).toEqual(versionKey === "chunkingVersion" ? alphaResult : []);
  expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(versions[versionKey] - 1);
});
it.each([
  {
    model: "embeddinggemma",
    document: /^title: none \| text: /,
    query: "task: search result | query: alpha",
  },
  { model: "nvidia/Nemotron-3-Embed-8B-BF16", document: /^passage: /, query: "query: alpha" },
])(
  "re-embeds unchanged legacy $model cache rows once on ordinary search",
  async ({ model, document, query }) => {
    const cfg = fixture.createConfig({
      model,
      cacheEnabled: true,
      vectorEnabled: false,
    });
    const dbPath = await publishIndex(cfg);
    // Reopen the unchanged fixture cache under the identity used before task prefixes.
    const legacyProviderKey = withDatabase(dbPath, (db) => {
      const meta = readMeta(db);
      const providerKey = hashText(JSON.stringify({ provider: meta.provider, model: meta.model }));
      delete meta.embeddingInputFormatVersion;
      updateMeta(db, { ...meta, providerKey });
      db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(providerKey);
      expect(
        db.prepare("SELECT count(*) AS count FROM memory_embedding_cache").get()?.count,
      ).toBeGreaterThan(0);
      return providerKey;
    });
    provider.embeddedBatchTexts.length = 0;
    provider.embeddedQueryTexts.length = 0;
    const previousBatches = provider.embedBatchCalls;
    const manager = await fixture.getFreshManager(cfg);
    expect(await manager.search("alpha")).toEqual(alphaResult);
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(provider.embedBatchCalls).toBeGreaterThan(previousBatches);
    expect(provider).toMatchObject({
      embeddedBatchTexts: [expect.stringMatching(document)],
      embeddedQueryTexts: [query],
    });
    await closeManager(manager);
    const upgraded = withDatabase(dbPath, readMeta);
    expect(upgraded.embeddingInputFormatVersion).toBe(1);
    expect(upgraded.providerKey).not.toBe(legacyProviderKey);
    const rebuiltBatches = provider.embedBatchCalls;
    const reopened = await fixture.getFreshManager(cfg);
    await reopened.sync({ reason: "watch" });
    expect(await reopened.search("alpha")).not.toEqual([]);
    expect(provider.embedBatchCalls).toBe(rebuiltBatches);
    expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
    await closeManager(reopened);
    expect(withDatabase(dbPath, readMeta)).toEqual(upgraded);
  },
);

it("re-embeds cached documents after an alias format change but reuses them for query changes", async () => {
  const cfg = fixture.createConfig({ model: "alias", cacheEnabled: true, vectorEnabled: false });
  const search = cfg.memory?.search;
  if (!search) {
    throw new Error("fixture memory search configuration is missing");
  }
  search.inputFormat = { query: "query: ", document: "passage: " };
  await publishIndex(cfg);
  const previousBatches = provider.embedBatchCalls;
  search.inputFormat = { query: "custom: ", document: "passage: " };
  let manager = await fixture.getFreshManager(cfg);
  await manager.sync({ reason: "cli", force: true });
  expect(provider.embedBatchCalls).toBe(previousBatches);
  await closeManager(manager);
  search.inputFormat.document = "document: ";
  provider.embeddedBatchTexts.length = 0;
  manager = await fixture.getFreshManager(cfg);
  await manager.sync({ reason: "cli", force: true });
  expect(provider.embedBatchCalls).toBeGreaterThan(previousBatches);
  expect(provider.embeddedBatchTexts).toEqual([expect.stringMatching(/^document: /)]);
  expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
});

it("re-embeds when explicit raw documents replace provider-owned formatting", async () => {
  const cfg = fixture.createConfig({
    model: "gemini-embedding-2",
    cacheEnabled: true,
    vectorEnabled: false,
  });
  const dbPath = await publishIndex(cfg);
  const previousKey = withDatabase(dbPath, readMeta).providerKey;
  const previousBatches = provider.embedBatchCalls;
  const search = cfg.memory?.search;
  if (!search) {
    throw new Error("fixture memory search configuration is missing");
  }
  search.inputFormat = { query: "", document: "" };
  const manager = await fixture.getFreshManager(cfg);
  await manager.sync({ reason: "cli", force: true });
  expect(provider.embedBatchCalls).toBeGreaterThan(previousBatches);
  expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  await closeManager(manager);
  expect(withDatabase(dbPath, readMeta).providerKey).not.toBe(previousKey);
});

it.each(["chunking upgrade", "content change", "orphan cache"] as const)(
  "binds legacy embeddings once across %s without reusing them after a digest change",
  async (mode) => {
    const cfg = fixture.createConfig({ cacheEnabled: true, vectorEnabled: false });
    const legacy = { provider: "mock", model: "mock-embed" };
    const legacyKey = hashText(JSON.stringify(legacy));
    let digest = "A";
    const createProvider = embeddings.createEmbeddingProvider;
    const factory = vi
      .spyOn(embeddings, "createEmbeddingProvider")
      .mockImplementation(async (...args) => {
        const result = await createProvider(...args);
        const backend = result.provider;
        if (!backend) {
          return result;
        }
        const modelDigest = digest;
        return {
          ...result,
          provider: {
            ...backend,
            embedBatch: async (...input) => {
              const vectors = await backend.embedBatch(...input);
              return modelDigest === "B" ? vectors.map(() => [0, 0, 1, 0]) : vectors;
            },
          },
          runtime: {
            ...result.runtime,
            id: backend.id,
            cacheKeyData: { ...legacy, modelDigest },
            indexIdentityAliases: [{ model: legacy.model, cacheKeyData: legacy }],
          },
        };
      });
    try {
      let dbPath: string;
      if (mode === "orphan cache") {
        const empty = await fixture.getFreshManager(cfg, "cli");
        const candidate = empty.status().dbPath;
        if (!candidate) {
          throw new Error("fixture database path is missing");
        }
        dbPath = candidate;
        await closeManager(empty);
        const text = await fs.readFile(path.join(fixture.paths.memory, "2026-01-12.md"), "utf8");
        // An embedding request can finish before the first index publication.
        withDatabase(dbPath, (db) => {
          db.prepare(`INSERT INTO memory_embedding_cache
            (provider, model, provider_key, hash, embedding, dims, updated_at)
            VALUES (?, ?, ?, ?, ?, 4, 1)`).run(
            legacy.provider,
            legacy.model,
            legacyKey,
            hashText(text),
            encodeMemoryEmbedding([1, 0, 0, 0]),
          );
        });
      } else {
        dbPath = await publishIndex(cfg);
        withDatabase(dbPath, (db) => {
          const meta = readMeta(db);
          updateMeta(db, {
            ...meta,
            providerKey: legacyKey,
            ...(mode === "chunking upgrade"
              ? { chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }
              : {}),
          });
          db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(legacyKey);
        });
        if (mode === "content change") {
          const search = cfg.memory?.search;
          if (!search) {
            throw new Error("fixture memory configuration is missing");
          }
          search.extraPaths = [fixture.paths.memory];
        }
      }
      const chunks = () =>
        withDatabase(dbPath, (db) =>
          db.prepare("SELECT text, embedding FROM memory_index_chunks ORDER BY id").all(),
        );
      const previousChunks = chunks();
      const previousCalls = provider.embedBatchCalls;
      const adopted = await fixture.getFreshManager(cfg, "cli");
      await adopted.sync({ reason: "cli" });
      await closeManager(adopted);
      if (mode === "orphan cache") {
        expect(provider.embedBatchCalls).toBeGreaterThan(previousCalls);
      } else {
        expect(provider.embedBatchCalls).toBe(previousCalls);
        expect(chunks()).toEqual(previousChunks);
      }
      const firstKey = withDatabase(dbPath, readMeta).providerKey;
      expect(firstKey).not.toBe(legacyKey);
      if (mode === "chunking upgrade") {
        expect(
          withDatabase(
            dbPath,
            (db) =>
              db
                .prepare(
                  "SELECT count(*) AS count FROM memory_embedding_cache WHERE provider_key = ?",
                )
                .get(legacyKey)?.count,
          ),
        ).toBe(0);
      }
      digest = "B";
      const adoptedCalls = provider.embedBatchCalls;
      const changed = await fixture.getFreshManager(cfg, "cli");
      await changed.sync({ reason: "cli", force: true });
      await closeManager(changed);
      expect(provider.embedBatchCalls).toBeGreaterThan(adoptedCalls);
      expect(withDatabase(dbPath, readMeta).providerKey).not.toBe(firstKey);
      expect(
        chunks().map((chunk) => {
          if (!(chunk.embedding instanceof Uint8Array)) {
            throw new Error("fixture vector is not binary");
          }
          return decodeMemoryEmbedding(chunk.embedding);
        }),
      ).toEqual([[0, 0, 1, 0]]);
    } finally {
      factory.mockRestore();
    }
  },
);
