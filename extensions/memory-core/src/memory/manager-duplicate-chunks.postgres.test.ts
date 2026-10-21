import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { readMemorySearchManagerStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresProductScope } from "../postgres-product.test-support.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";

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
  const database = postgresProductScope("memory_duplicates");
  const scenarios = ["fresh", "shadow", "incremental"] as const;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let config: OpenClawConfig;
  let run = AsyncLocalStorage.snapshot();
  let connected = false;

  beforeAll(async () => {
    if (engine === "postgres" && !database.connection) {
      return;
    }
    state = await createOpenClawTestState({
      label: `memory-duplicate-chunks-${engine}`,
      layout: "state-only",
    });
    await configureMemoryCoreDreamingStateForTests();
    if (engine === "postgres") {
      await database.connect();
      connected = true;
    }
    config = {
      database: { engine },
      plugins: { enabled: false },
      agents: {
        entries: {
          fresh: { workspace: path.join(state.workspaceDir, "fresh") },
          shadow: { workspace: path.join(state.workspaceDir, "shadow") },
          incremental: { workspace: path.join(state.workspaceDir, "incremental") },
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
    };
    setRuntimeConfigSnapshot(config);
    run = database.select(() => AsyncLocalStorage.snapshot(), config);
  });

  afterEach(() => run(() => closeAllMemorySearchManagers()));
  afterAll(async () => {
    try {
      await run(async () => {
        await closeAllMemorySearchManagers();
        resetMemoryCoreDreamingStateForTests();
        await state?.cleanup();
      });
    } finally {
      if (connected) {
        await database.close();
      }
    }
  });

  it.skipIf(engine === "postgres" && !database.connection).each(scenarios)(
    "indexes repeat.md with 3,200 identical characters through %s sync",
    async (scenario) =>
      run(async () => {
        assert(state);
        const memory = path.join(state.workspaceDir, scenario, "memory");
        await fs.mkdir(memory, { recursive: true });
        const filename = path.join(memory, "repeat.md");
        const index = async (force = false) => {
          const result = await getMemorySearchManager({
            cfg: config,
            agentId: scenario,
            purpose: scenario === "incremental" ? "default" : "cli",
            runInBackgroundContext: run,
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
