import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMemoryEmbeddingRetryLoop } from "./manager-embedding-policy.js";

const servers: Server[] = [];

afterEach(async () => {
  const activeServers = servers.splice(0);
  await Promise.all(
    activeServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("memory embedding retry policy with remote transport", () => {
  it("fails after one request when the provider reports exhausted credits", async () => {
    let requestCount = 0;
    const server = createServer((request, response) => {
      void (async () => {
        try {
          request.resume();
          await once(request, "end");
          requestCount += 1;
          response.writeHead(429, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Credit balance exhausted",
                type: "rate_limit_error",
                code: "credit_balance_exhausted",
              },
            }),
          );
        } catch (error) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(error instanceof Error ? error.message : String(error));
        }
      })();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: { authorization: "Bearer fixture-token" },
        model: "text-embedding-3-small",
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      },
      errorPrefix: "openai embeddings failed",
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(
      runMemoryEmbeddingRetryLoop({
        profile: "index",
        run: async () => await provider.embedBatch(["alpha"], { inputType: "document" }),
        waitForRetry,
      }),
    ).rejects.toMatchObject({
      status: 429,
      code: "credit_balance_exhausted",
    });

    expect(requestCount).toBe(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });
});
