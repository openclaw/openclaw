import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

it("regenerates cached vectors that disagree with the provider's declared dimensions", async () => {
  const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
  const requests: unknown[] = [];
  await withServer(
    (req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
        requests.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
          }),
        );
      })().catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    },
    async (origin) => {
      const closeManagers = async () => {
        await closeAllMemorySearchManagers();
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
      };
      await withOpenClawTestState(
        { prefix: "memory-cache-dimensions-", layout: "state-only" },
        async (state) => {
          const cfg = isolateMemoryManagerTestConfig({
            agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
            memory: {
              search: {
                provider: "openai-compatible",
                model: "fixture-embedding",
                outputDimensionality: 3,
                fallback: "none",
                remote: { baseUrl: `${origin}/v1` },
                sources: ["memory"],
                store: { vector: { enabled: false } },
                cache: { enabled: true },
              },
            },
          });
          setRuntimeConfigSnapshot(cfg);
          await fs.mkdir(state.workspaceDir, { recursive: true });
          await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), "Alpha memory.\n");
          const openManager = async () => {
            const { manager } = await getMemorySearchManager({
              cfg,
              agentId: "main",
              purpose: "cli",
              runInBackgroundContext: runInMemoryTestBackgroundContext,
            });
            if (!manager?.sync) {
              throw new Error("fixture memory index manager is unavailable");
            }
            return { manager, sync: manager.sync.bind(manager) };
          };
          try {
            const seeded = await openManager();
            await seeded.sync({ reason: "cli", force: true });
            const dbPath = seeded.manager.status().dbPath;
            if (!dbPath) {
              throw new Error("fixture database path is missing");
            }
            await closeManagers();
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

            const reopened = await openManager();
            await reopened.sync({ reason: "cli", force: true });
            await closeManagers();
            expect(requests).toHaveLength(2);
            using repaired = new DatabaseSync(dbPath, { readOnly: true });
            const cached = repaired
              .prepare("SELECT provider_key, embedding, dims FROM memory_embedding_cache")
              .get();
            expect(cached?.provider_key).toEqual(originalKey);
            expect(cached?.dims).toBe(3);
            if (!(cached?.embedding instanceof Uint8Array)) {
              throw new Error("fixture cache vector is missing");
            }
            expect(decodeMemoryEmbedding(cached.embedding)).toEqual([1, 0, 0]);
          } finally {
            await closeManagers();
          }
        },
      );
    },
  );
});
