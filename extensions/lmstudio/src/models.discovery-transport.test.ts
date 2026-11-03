import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { discoverLmstudioModels } from "./models.fetch.js";

describe("LM Studio discovery transport", () => {
  it("reaches loopback only when private network access is allowed", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"models":[]}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("Expected a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const discover = (allowPrivateNetwork: boolean) =>
      discoverLmstudioModels({ baseUrl, apiKey: "lm-token", quiet: true, allowPrivateNetwork });
    try {
      await discover(false);
      expect(hits).toBe(0);
      await discover(true);
      expect(hits).toBe(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
