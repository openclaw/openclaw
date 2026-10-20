import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

it("retains the previous custom-auth index and cache after credential rotation", async () => {
  const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
  const { acquireTestPortBlock } = await import("openclaw/plugin-sdk/test-env");
  const requests: string[][] = [];
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      requests.push(body.input);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: body.input.map((text, index) => ({
            index,
            embedding: text.toLowerCase().includes("alpha") ? [1, 0, 0] : [0, 1, 0],
          })),
        }),
      );
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
    await withOpenClawTestState(
      { prefix: "memory-compatible-upgrade-", layout: "state-only" },
      async (state) => {
        const baseUrl = `http://127.0.0.1:${claim.port}/v1`;
        const model = "fixture-embedding";
        const configure = (key: string) =>
          isolateMemoryManagerTestConfig({
            agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
            memory: {
              search: {
                provider: "openai-compatible",
                model,
                fallback: "none",
                store: { vector: { enabled: false } },
                query: { minScore: 0 },
                cache: { enabled: true },
              },
            },
            models: {
              providers: {
                "openai-compatible": {
                  baseUrl,
                  headers: { "X-oMLX-Key": key },
                  request: {
                    auth: { mode: "header", headerName: "X-oMLX-Key", value: key },
                  },
                  models: [],
                },
              },
            },
          });
        let cfg = configure("fixture-old-key");
        setRuntimeConfigSnapshot(cfg);
        await fs.mkdir(path.join(state.workspaceDir, "memory"), { recursive: true });
        await fs.writeFile(
          path.join(state.workspaceDir, "memory", "2026-01-12.md"),
          "alpha\nZebra memory line.\n",
        );
        const openManager = () =>
          getMemorySearchManager({
            cfg,
            agentId: "main",
            purpose: "cli",
            runInBackgroundContext: runInMemoryTestBackgroundContext,
          });
        const closeManagers = async () => {
          await closeAllMemorySearchManagers();
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
        };
        try {
          const seeded = (await openManager()).manager;
          if (!seeded?.sync) {
            throw new Error("fixture memory index manager is unavailable");
          }
          await seeded.sync({ reason: "test", force: true });
          const dbPath = seeded.status().dbPath;
          if (!dbPath) {
            throw new Error("fixture database path is missing");
          }
          await closeManagers();

          // Before custom auth was excluded, this exact header map formed the persisted key.
          const legacyProviderKey = hashText(
            JSON.stringify({
              provider: "openai-compatible",
              baseUrl,
              model,
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "x-omlx-key": "fixture-old-key",
              },
            }),
          );
          const db = new DatabaseSync(dbPath);
          const indexedChunks = db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
          try {
            const row = db
              .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
              .get();
            if (typeof row?.value !== "string") {
              throw new Error("fixture index metadata is missing");
            }
            const meta = JSON.parse(row.value) as MemoryIndexMeta;
            db.prepare(
              "UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'",
            ).run(JSON.stringify({ ...meta, providerKey: legacyProviderKey }));
            db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(legacyProviderKey);
          } finally {
            db.close();
          }
          const documentRequests = () =>
            requests.flat().filter((text) => text.includes("Zebra memory line.")).length;
          const indexedDocuments = documentRequests();
          expect(indexedDocuments).toBeGreaterThan(0);
          const reopened = (await openManager()).manager;
          if (!reopened) {
            throw new Error("fixture memory index manager did not reopen");
          }
          expect(await reopened.search("alpha")).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
          );
          expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
          expect(documentRequests()).toBe(indexedDocuments);
          await closeManagers();
          const upgraded = new DatabaseSync(dbPath, { readOnly: true });
          try {
            expect(upgraded.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(
              indexedChunks,
            );
          } finally {
            upgraded.close();
          }

          cfg = configure("fixture-rotated-key");
          setRuntimeConfigSnapshot(cfg);
          const rotated = (await openManager()).manager;
          if (!rotated?.sync) {
            throw new Error("rotated memory index manager did not reopen");
          }
          expect(await rotated.search("alpha")).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
          );
          expect(rotated.status().custom?.indexIdentity).toEqual({ status: "valid" });
          expect(documentRequests()).toBe(indexedDocuments);
          // Explicit rebuilding must retain the cache after the credential-dependent key is gone.
          await rotated.sync({ reason: "test", force: true });
          expect(documentRequests()).toBe(indexedDocuments);
        } finally {
          await closeManagers();
        }
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await claim.release();
  }
});
