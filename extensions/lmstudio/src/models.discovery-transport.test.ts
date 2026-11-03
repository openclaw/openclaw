import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { discoverLmstudioModels } from "./models.fetch.js";

async function listen(): Promise<{ server: Server; port: number; hits: { count: number } }> {
  const hits = { count: 0 };
  const server = createServer((_request: IncomingMessage, response) => {
    hits.count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP port");
  }
  return { server, port: address.port, hits };
}

describe("LM Studio discovery transport", () => {
  it("reaches a loopback server only when private network access is allowed", async () => {
    const listener = await listen();
    const baseUrl = `http://127.0.0.1:${listener.port}/v1`;
    try {
      await expect(
        discoverLmstudioModels({
          baseUrl,
          apiKey: "lm-token",
          quiet: true,
          allowPrivateNetwork: false,
        }),
      ).resolves.toEqual([]);
      expect(listener.hits.count).toBe(0);
      await expect(
        discoverLmstudioModels({
          baseUrl,
          apiKey: "lm-token",
          quiet: true,
          allowPrivateNetwork: true,
        }),
      ).resolves.toEqual([]);
      expect(listener.hits.count).toBe(1);
    } finally {
      listener.server.close();
      await once(listener.server, "close");
    }
  });
});
