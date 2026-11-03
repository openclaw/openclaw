import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { readMemorySearchManagerStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { createPostgresIndexFixture } from "./postgres-index.test-support.js";

// Keep file preparation, publication and retrieval real; only replace the embedding service.
vi.mock("./embeddings.js", async (original) => ({
  ...(await original<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => ({
    provider: { id: "openai", model: "duplicate-chunks-fixture" },
  }),
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "duplicate-chunks-fixture",
      embed: async () => [1, 0, 0],
      embedBatch: async (inputs: EmbeddingInput[]) => inputs.map(() => [1, 0, 0]),
    },
  }),
}));

describe.each(["sqlite", "postgres"] as const)("%s repeated memory chunks", (engine) => {
  const scenarios = ["fresh", "shadow", "incremental"] as const;
  const fixture = createPostgresIndexFixture("memory_duplicates", engine, (workspace) => ({
    database: { engine },
    plugins: { enabled: false },
    agents: {
      entries: {
        fresh: { workspace: path.join(workspace, "fresh") },
        shadow: { workspace: path.join(workspace, "shadow") },
        incremental: { workspace: path.join(workspace, "incremental") },
      },
    },
    memory: {
      search: {
        provider: "openai",
        model: "duplicate-chunks-fixture",
        fallback: "none",
        sources: ["memory"],
        cache: { enabled: false },
        store: { vector: { enabled: true } },
        query: { minScore: 0 },
      },
    },
  }));

  afterEach(() => fixture.run(() => closeAllMemorySearchManagers()));

  it.skipIf(fixture.unavailable).each(scenarios)(
    "indexes repeat.md with 3,200 identical characters through %s sync",
    async (scenario) =>
      fixture.run(async () => {
        const memory = path.join(fixture.workspace, scenario, "memory");
        await fs.mkdir(memory, { recursive: true });
        const filename = path.join(memory, "repeat.md");
        const index = async (force = false) => {
          const result = await getMemorySearchManager({
            cfg: fixture.config,
            agentId: scenario,
            purpose: scenario === "incremental" ? "default" : "cli",
            runInBackgroundContext: fixture.run,
          });
          assert(result.manager, result.error ?? "Expected memory manager");
          assert(typeof result.manager.sync === "function", "Expected memory indexing support");
          await result.manager.sync({ reason: "cli", force });
          return result.manager;
        };
        if (scenario !== "fresh") {
          await fs.writeFile(filename, "A unique initial memory chunk.");
          const seeded = await index();
          expect(await readMemorySearchManagerStatus(seeded)).toMatchObject({
            files: 1,
            chunks: 1,
          });
          // Reopen the same index; serving managers schedule an incremental memory scan.
          await closeAllMemorySearchManagers();
        }
        await fs.writeFile(filename, "x".repeat(3200));
        const manager = await index(scenario === "shadow");
        expect(await readMemorySearchManagerStatus(manager)).toMatchObject({ files: 1, chunks: 1 });
        const results = await manager.search("x".repeat(32), { minScore: 0, maxResults: 1 });
        expect(results).toMatchObject([{ path: "memory/repeat.md" }]);
        expect(results[0]?.snippet).toContain("x".repeat(32));
      }),
  );
});
