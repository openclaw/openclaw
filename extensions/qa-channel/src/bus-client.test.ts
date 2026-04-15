import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { pollQaBus } from "./bus-client.js";

async function startJsonServer(handler: () => { statusCode?: number; body: string }) {
  const server = createServer((_req, res) => {
    const response = handler();
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("qa-bus client", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const server = await startJsonServer(() => ({
      body: '{"cursor":1,"events":[',
    }));
    stops.push(server.stop);

    await expect(
      pollQaBus({
        baseUrl: server.baseUrl,
        accountId: "acct-a",
        cursor: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(SyntaxError);
  });
});
