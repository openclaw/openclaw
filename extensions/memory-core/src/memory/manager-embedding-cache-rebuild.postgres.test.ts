import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { readMemorySearchManagerStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { getMemorySearchManager } from "./index.js";
import { createPostgresIndexFixture } from "./postgres-index.test-support.js";

const embeddingInputs = vi.hoisted(() => [] as Array<string | EmbeddingInput>);

// Keep file preparation, cache access and publication real; replace only the embedding service.
vi.mock("./embeddings.js", async (original) => ({
  ...(await original<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => ({
    provider: { id: "ollama", model: "cache-rebuild-fixture" },
  }),
  createEmbeddingProvider: async () => ({
    requestedProvider: "ollama",
    provider: {
      id: "ollama",
      model: "cache-rebuild-fixture",
      embed: async () => [1, 0, 0],
      embedBatch: async (inputs: Array<string | EmbeddingInput>) => {
        embeddingInputs.push(...inputs);
        return inputs.map(() => [1, 0, 0]);
      },
    },
  }),
}));

describe("PostgreSQL full memory rebuild at cache capacity", () => {
  const fixture = createPostgresIndexFixture("memory_cache_rebuild", "postgres", (workspace) => ({
    database: { engine: "postgres" },
    plugins: { enabled: false },
    agents: { entries: { main: { workspace } } },
    memory: {
      search: {
        provider: "ollama",
        model: "cache-rebuild-fixture",
        fallback: "none",
        sources: ["memory"],
        cache: { enabled: true },
        store: { vector: { enabled: true } },
      },
    },
  }));

  it.skipIf(fixture.unavailable)(
    "embeds only misses and retains every needed vector after pruning",
    async () =>
      fixture.run(async () => {
        const memory = path.join(fixture.workspace, "memory");
        await fs.mkdir(memory, { recursive: true });
        await fs.writeFile(path.join(memory, "b.md"), "Previously cached beta.");
        await fs.writeFile(path.join(memory, "c.md"), "Previously cached gamma.");
        const result = await getMemorySearchManager({
          cfg: fixture.config,
          agentId: "main",
          purpose: "cli",
          runInBackgroundContext: fixture.run,
        });
        assert(result.manager, result.error ?? "Expected memory manager");
        const manager = result.manager;
        assert(typeof manager.sync === "function", "Expected memory indexing support");
        // Scale the production cache cap without changing the public configuration surface.
        (manager as unknown as { cache: { maxEntries?: number } }).cache.maxEntries = 4;
        await manager.sync({ reason: "cli", force: true });

        await fs.writeFile(path.join(memory, "d.md"), "Superseded delta.");
        await fs.writeFile(path.join(memory, "e.md"), "Superseded epsilon.");
        await manager.sync({ reason: "search-bootstrap" });
        await fs.rm(path.join(memory, "d.md"));
        await fs.rm(path.join(memory, "e.md"));
        await manager.sync({ reason: "search-bootstrap" });
        expect(await readMemorySearchManagerStatus(manager)).toMatchObject({
          files: 2,
          chunks: 2,
          cache: { entries: 4 },
        });

        // The newer superseded cache rows fail the old-unreferenced cutoff. The
        // first file misses before the serial provider reaches the cached files.
        const missing = "New alpha has no cached embedding.";
        await fs.writeFile(path.join(memory, "a.md"), missing);
        embeddingInputs.length = 0;
        await manager.sync({ reason: "cli", force: true });
        expect(embeddingInputs).toEqual([missing]);
        expect(await readMemorySearchManagerStatus(manager)).toMatchObject({
          files: 3,
          chunks: 3,
          cache: { entries: 4 },
        });

        embeddingInputs.length = 0;
        await manager.sync({ reason: "cli", force: true });
        expect(embeddingInputs).toEqual([]);
      }),
  );
});
