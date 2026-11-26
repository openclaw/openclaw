import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { readMemorySearchManagerStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { createPostgresIndexFixture } from "./postgres-index.test-support.js";

// Only the external embedding service is replaced; admission, indexing and search stay real.
vi.mock("./embeddings.js", async (original) => ({
  ...(await original<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: ({
    model,
    provider,
  }: {
    model: string;
    provider: string;
  }) => (provider === "none" ? undefined : { provider: { id: "openai", model } }),
  createEmbeddingProvider: async ({ model }: { model: string }) => {
    const embedding = model === "four-dimensions" ? [1, 0, 0, 0] : [1, 0, 0];
    return {
      requestedProvider: "openai",
      provider: {
        id: "openai",
        model,
        embed: async () => embedding,
        embedBatch: async (inputs: EmbeddingInput[]) => inputs.map(() => embedding),
      },
    };
  },
}));

describe("PostgreSQL memory search definition rebuild", () => {
  const fixture = createPostgresIndexFixture("memory_search_rebuild", "postgres", (workspace) => ({
    database: { engine: "postgres" },
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      entries: {
        dimensions: { workspace: path.join(workspace, "dimensions") },
        tokenizer: { workspace: path.join(workspace, "tokenizer") },
      },
    },
    memory: {
      search: {
        provider: "openai",
        model: "three-dimensions",
        fallback: "none",
        sources: ["memory"],
        cache: { enabled: false },
        store: { vector: { enabled: true }, fts: { tokenizer: "unicode61" } },
        query: { minScore: 0 },
      },
    },
  }));

  afterEach(() => fixture.run(() => closeAllMemorySearchManagers()));

  it.skipIf(fixture.unavailable).each(["dimensions", "tokenizer"] as const)(
    "rebuilds a populated index after changing %s, then reopens it",
    async (change) =>
      fixture.run(async () => {
        const memory = path.join(fixture.workspace, change, "memory");
        await fs.mkdir(memory, { recursive: true });
        await fs.writeFile(path.join(memory, "quartz.md"), "Quartz compass points north.");
        const config = structuredClone(fixture.config);
        assert(config.memory?.search?.store?.vector);
        config.memory.search.store.vector.enabled = change === "dimensions";
        if (change === "tokenizer") {
          config.memory.search.provider = "none";
        }
        const index = async () => {
          const result = await getMemorySearchManager({
            cfg: config,
            agentId: change,
            purpose: "cli",
            runInBackgroundContext: fixture.run,
          });
          assert(result.manager, result.error ?? "Expected memory manager");
          assert(typeof result.manager.sync === "function");
          await result.manager.sync({ reason: "cli", force: true });
          return result.manager;
        };
        const seeded = await index();
        expect(await readMemorySearchManagerStatus(seeded)).toMatchObject({ files: 1, chunks: 1 });
        await closeAllMemorySearchManagers();
        assert(config.memory?.search?.store?.fts);
        if (change === "dimensions") {
          config.memory.search.model = "four-dimensions";
        } else {
          config.memory.search.store.fts.tokenizer = "trigram";
        }
        const rebuilt = await index();
        expect(await readMemorySearchManagerStatus(rebuilt)).toMatchObject({ files: 1, chunks: 1 });
        // A partial word must come from trigram retrieval, without vector fallback.
        const query = change === "tokenizer" ? "uart" : "quartz";
        expect(await rebuilt.search(query, { minScore: 0 })).toMatchObject([
          { path: "memory/quartz.md" },
        ]);
        await closeAllMemorySearchManagers();
        const reopened = await index();
        expect(await reopened.search(query, { minScore: 0 })).toMatchObject([
          { path: "memory/quartz.md" },
        ]);
        await closeAllMemorySearchManagers();
        config.memory.search.model = "three-dimensions";
        config.memory.search.store.fts.tokenizer = "unicode61";
        const restored = await index();
        expect(await restored.search("quartz", { minScore: 0 })).toMatchObject([
          { path: "memory/quartz.md" },
        ]);
      }),
  );
});
