import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import {
  seedLegacyMemoryIndex,
  closeCompatibleIndexManagers,
  readCompatibleIndexChunks,
} from "./manager-compatible-index.test-support.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

it("retains the previous custom-auth index and cache after credential rotation", async () => {
  const { getMemorySearchManager } = await import("./index.js");
  const requests: string[][] = [];
  await withServer(
    (req, res) => {
      void (async () => {
        const body = (await json(req)) as { input: string[] };
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
    },
    async (origin) => {
      await withOpenClawTestState(
        { prefix: "memory-compatible-upgrade-", layout: "state-only" },
        async (state) => {
          const baseUrl = `${origin}/v1`;
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
          const notePath = "memory/2026-01-12.md";
          const noteResult = expect.objectContaining({ path: notePath });
          await fs.mkdir(path.join(state.workspaceDir, "memory"), { recursive: true });
          await fs.writeFile(
            path.join(state.workspaceDir, notePath),
            "alpha\nZebra memory line.\n",
          );
          const openManager = () =>
            getMemorySearchManager({
              cfg,
              agentId: "main",
              purpose: "cli",
              runInBackgroundContext: runInMemoryTestBackgroundContext,
            });
          try {
            const seeded = (await openManager()).manager;
            assert(
              seeded && typeof seeded.sync === "function",
              "fixture memory index manager is unavailable",
            );
            await seeded.sync({ reason: "test", force: true });
            const dbPath = seeded.status().dbPath;
            assert(dbPath, "fixture database path is missing");
            await closeCompatibleIndexManagers();

            // Before custom auth was excluded, this exact header map formed the persisted key.
            const indexedChunks = seedLegacyMemoryIndex(dbPath, {
              provider: "openai-compatible",
              baseUrl,
              model,
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "x-omlx-key": "fixture-old-key",
              },
            });
            const documentRequests = () =>
              requests.flat().filter((text) => text.includes("Zebra memory line.")).length;
            const indexedDocuments = documentRequests();
            expect(indexedDocuments).toBeGreaterThan(0);
            const reopened = (await openManager()).manager;
            assert(reopened, "fixture memory index manager did not reopen");
            expect(await reopened.search("alpha")).toContainEqual(noteResult);
            expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
            expect(documentRequests()).toBe(indexedDocuments);
            await closeCompatibleIndexManagers();
            expect(readCompatibleIndexChunks(dbPath)).toEqual(indexedChunks);

            cfg = configure("fixture-rotated-key");
            setRuntimeConfigSnapshot(cfg);
            const rotated = (await openManager()).manager;
            assert(
              rotated && typeof rotated.sync === "function",
              "rotated memory index manager did not reopen",
            );
            expect(await rotated.search("alpha")).toContainEqual(noteResult);
            expect(rotated.status().custom?.indexIdentity).toEqual({ status: "valid" });
            expect(documentRequests()).toBe(indexedDocuments);
            // Explicit rebuilding must retain the cache after the credential-dependent key is gone.
            await rotated.sync({ reason: "test", force: true });
            expect(documentRequests()).toBe(indexedDocuments);
          } finally {
            await closeCompatibleIndexManagers();
          }
        },
      );
    },
  );
});
