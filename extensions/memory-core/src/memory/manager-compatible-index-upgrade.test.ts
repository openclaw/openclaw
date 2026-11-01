import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withEmbeddingHttpFixture } from "./embedding-http.test-support.js";
import {
  seedLegacyMemoryIndex,
  closeCompatibleIndexManagers,
  readCompatibleIndexChunks,
} from "./manager-compatible-index.test-support.js";

it("retains the previous custom-auth index and cache after credential rotation", async () => {
  await withEmbeddingHttpFixture(
    "memory-compatible-upgrade-",
    async ({ workspace, baseUrl, requests, configure, open }) => {
      const model = "fixture-embedding";
      const configureKey = (key: string) =>
        configure({
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
                request: { auth: { mode: "header", headerName: "X-oMLX-Key", value: key } },
                models: [],
              },
            },
          },
        });
      configureKey("fixture-old-key");
      const notePath = "memory/2026-01-12.md";
      const noteResult = expect.objectContaining({ path: notePath });
      await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspace, notePath), "alpha\nZebra memory line.\n");
      const { manager: seeded, sync: seed } = await open();
      await seed({ reason: "test", force: true });
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
      const checkIndex = async () => {
        const current = await open();
        expect(await current.manager.search("alpha")).toContainEqual(noteResult);
        expect(current.manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
        expect(documentRequests()).toBe(indexedDocuments);
        return current;
      };
      await checkIndex();
      await closeCompatibleIndexManagers();
      expect(readCompatibleIndexChunks(dbPath)).toEqual(indexedChunks);
      configureKey("fixture-rotated-key");
      const rotated = await checkIndex();
      // Explicit rebuilding must retain the cache after the credential-dependent key is gone.
      await rotated.sync({ reason: "test", force: true });
      expect(documentRequests()).toBe(indexedDocuments);
    },
  );
});
