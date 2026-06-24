// Qa Channel tests cover gateway lifecycle behavior.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startQaGatewayAccount } from "./gateway.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
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

describe("qa-channel gateway", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("clears running status when polling fails", async () => {
    const server = await startJsonServer(() => ({
      statusCode: 500,
      body: JSON.stringify({ error: "qa bus unavailable" }),
    }));
    stops.push(() => server.stop());
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };
    const setStatus = vi.fn();

    await expect(
      startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: new AbortController().signal,
        account,
        cfg: {},
        setStatus,
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>),
    ).rejects.toThrow("qa bus unavailable");

    expect(setStatus.mock.calls.map(([status]) => status)).toEqual([
      {
        accountId: "default",
        baseUrl: server.baseUrl,
        configured: true,
        enabled: true,
        running: true,
      },
      {
        accountId: "default",
        running: false,
      },
    ]);
  });
});
