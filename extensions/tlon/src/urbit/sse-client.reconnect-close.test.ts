import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
const runningServers: Server[] = [];

async function startUrbitChannelServer(): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Tlon SSE lifecycle state");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("UrbitSSEClient reconnect close lifecycle", () => {
  it("does not reconnect after close interrupts a real SSE backoff", async () => {
    const { baseUrl, requests } = await startUrbitChannelServer();
    const logs: string[] = [];
    let reconnects = 0;
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      reconnectDelay: 1_000,
      logger: { log: (message) => logs.push(message) },
      onReconnect: (reconnectingClient) => {
        reconnects += 1;
        reconnectingClient.autoReconnect = false;
      },
    });

    await client.connect();
    await waitFor(() => logs.some((message) => message.includes("in 1000ms")));
    await client.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 1_050);
    });

    expect(reconnects).toBe(0);
    expect(requests).toHaveLength(5);
  });

  it("still reconnects when the backoff expires normally", async () => {
    const { baseUrl, requests } = await startUrbitChannelServer();
    let reconnects = 0;
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      reconnectDelay: 100,
      onReconnect: (reconnectingClient) => {
        reconnects += 1;
        reconnectingClient.autoReconnect = false;
      },
    });

    await client.connect();
    await waitFor(() => reconnects === 1);
    await waitFor(() => requests.length === 6);
    await client.close();

    expect(reconnects).toBe(1);
  });
});
