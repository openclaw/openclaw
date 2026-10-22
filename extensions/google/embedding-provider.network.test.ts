import { testEmbeddingNetworkPolicy } from "../test-support/embedding-network.test-support.js";
import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

testEmbeddingNetworkPolicy({
  id: "gemini",
  configId: "google",
  create: createGeminiEmbeddingProvider,
});

import { createServer } from "node:http";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";

it.each([undefined, false, true])(
  "applies allowPrivateNetwork=%s to the Gemini batch lifecycle",
  async (allowPrivateNetwork) => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const requests: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/upload/")) {
        res.end(JSON.stringify({ file: { name: "files/input" } }));
      } else if (req.url?.endsWith(":asyncBatchEmbedContent")) {
        res.end(JSON.stringify({ name: "batches/probe", done: false }));
      } else if (req.url === "/v1beta/batches/probe") {
        res.end(
          JSON.stringify({
            name: "batches/probe",
            done: true,
            response: { responsesFile: "files/output" },
          }),
        );
      } else {
        res.end(
          JSON.stringify({ key: "probe", response: { embedding: { values: [1, 0] } } }) + "\n",
        );
      }
    });
    const wait = vi
      .spyOn(providerHttp, "waitProviderOperationPollInterval")
      .mockResolvedValue(undefined);
    try {
      await new Promise<void>((resolve) => {
        server.listen(claim.port, "127.0.0.1", resolve);
      });
      const { client } = await createGeminiEmbeddingProvider({
        config: {
          models: {
            providers: {
              google: {
                baseUrl: `http://127.0.0.1:${claim.port}/v1beta`,
                request: { allowPrivateNetwork },
                models: [],
              },
            },
          },
        },
        provider: "gemini",
        model: "fixture-model",
        fallback: "none",
        remote: { apiKey: "fixture-key" },
      });
      const result = runGeminiEmbeddingBatches({
        gemini: client,
        agentId: "fixture",
        wait: true,
        pollIntervalMs: 0,
        timeoutMs: 10000,
        concurrency: 1,
        requests: [{ custom_id: "probe", request: { content: { parts: [{ text: "hello" }] } } }],
      });
      if (allowPrivateNetwork === false) {
        await expect(result).rejects.toThrow(/private\/internal\/special-use/);
        expect(requests).toEqual([]);
      } else {
        await expect(result).resolves.toEqual(new Map([["probe", [1, 0]]]));
        expect(requests).toEqual([
          "/upload/v1beta/files?uploadType=multipart",
          "/v1beta/models/fixture-model:asyncBatchEmbedContent",
          "/v1beta/batches/probe",
          "/v1beta/files/output:download?alt=media",
        ]);
      }
    } finally {
      wait.mockRestore();
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await claim.release();
    }
  },
);
