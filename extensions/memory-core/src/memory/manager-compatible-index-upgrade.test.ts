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
import "./test-runtime-mocks.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

it("reads the previous custom-auth identity without re-embedding indexed documents", async () => {
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
        const cfg = isolateMemoryManagerTestConfig({
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
                headers: { "X-oMLX-Key": "fixture-old-key" },
                request: {
                  auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-old-key" },
                },
                models: [],
              },
            },
          },
        });
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
            runInBackgroundContext: runInMemoryTestBackgroundContext,
          });
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
          await closeAllMemorySearchManagers();
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();

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
        } finally {
          await closeAllMemorySearchManagers();
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
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
