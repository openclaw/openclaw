import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { expect, it } from "vitest";
import { withEmbeddingHttpFixture } from "./embedding-http.test-support.js";
import { closeCompatibleIndexManagers } from "./manager-compatible-index.test-support.js";

it("regenerates cached vectors that disagree with the provider's declared dimensions", async () => {
  await withEmbeddingHttpFixture(
    "memory-cache-dimensions-",
    async ({ workspace, baseUrl, requests, configure, open }) => {
      configure({
        memory: {
          search: {
            provider: "openai-compatible",
            model: "fixture-embedding",
            outputDimensionality: 3,
            fallback: "none",
            remote: { baseUrl },
            sources: ["memory"],
            store: { vector: { enabled: false } },
            cache: { enabled: true },
          },
        },
      });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "MEMORY.md"), "Alpha memory.\n");
      const seeded = await open();
      await seeded.sync({ reason: "cli", force: true });
      const dbPath = seeded.manager.status().dbPath;
      assert(dbPath, "fixture database path is missing");
      await closeCompatibleIndexManagers();
      expect(requests).toHaveLength(1);

      // Older compatible servers could cache the native vector under a requested-size key.
      let originalKey: unknown;
      {
        using legacy = new DatabaseSync(dbPath);
        const cached = legacy
          .prepare("SELECT provider_key, dims FROM memory_embedding_cache")
          .get();
        expect(cached?.dims).toBe(3);
        originalKey = cached?.provider_key;
        expect(originalKey).toEqual(expect.any(String));
        const corrupted = legacy
          .prepare("UPDATE memory_embedding_cache SET embedding = ?, dims = 4")
          .run(encodeMemoryEmbedding([1, 0, 0, 0]));
        expect(corrupted.changes).toBe(1);
      }
      const reopened = await open();
      await reopened.sync({ reason: "cli", force: true });
      await closeCompatibleIndexManagers();
      expect(requests).toHaveLength(2);
      using repaired = new DatabaseSync(dbPath, { readOnly: true });
      const cached = repaired
        .prepare("SELECT provider_key, embedding, dims FROM memory_embedding_cache")
        .get();
      expect(cached).toMatchObject({ provider_key: originalKey, dims: 3 });
      assert(cached?.embedding instanceof Uint8Array, "fixture cache vector is missing");
      expect(decodeMemoryEmbedding(cached.embedding)).toEqual([1, 0, 0]);
    },
  );
});
