// Exercise real authenticated browser CDP response streams and TCP cleanup.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCdpChecked, fetchJson, fetchOk } from "./cdp.helpers.js";

const CDP_USERNAME = "openclaw";
const CDP_FIXTURE_TOKEN = "browser-cdp-transport-test";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${CDP_USERNAME}:${CDP_FIXTURE_TOKEN}`,
).toString("base64")}`;

type AuthenticatedCdpServer = {
  url: string;
  sockets: Set<Socket>;
  authorizations: Array<string | undefined>;
  close: () => Promise<void>;
};

const servers: AuthenticatedCdpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startAuthenticatedCdpServer(params: {
  status: number;
  streaming: boolean;
}): Promise<AuthenticatedCdpServer> {
  const sockets = new Set<Socket>();
  const authorizations: Array<string | undefined> = [];
  const server: Server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== EXPECTED_AUTHORIZATION) {
      response.writeHead(401);
      response.end();
      return;
    }

    response.writeHead(params.status, { "content-type": "application/json" });
    if (params.streaming) {
      // Keep the response body open until the actual CDP client cancels it.
      response.write('{"Browser":');
      return;
    }
    response.end(JSON.stringify({ Browser: "OpenClaw transport fixture" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected the browser CDP fixture to bind a loopback TCP port");
  }

  const fixture: AuthenticatedCdpServer = {
    url: `http://${CDP_USERNAME}:${CDP_FIXTURE_TOKEN}@127.0.0.1:${address.port}/json/version`,
    sockets,
    authorizations,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
  servers.push(fixture);
  return fixture;
}

async function expectAllSocketsReleased(server: AuthenticatedCdpServer): Promise<void> {
  await vi.waitFor(
    () => {
      expect(server.sockets.size).toBe(0);
    },
    { timeout: 1_250, interval: 20 },
  );
}

describe("browser CDP authenticated HTTP transport", () => {
  it("closes every unread streaming response after concurrent status probes", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    await Promise.all(Array.from({ length: 8 }, () => fetchOk(server.url, 1_000)));

    expect(server.authorizations).toEqual(Array(8).fill(EXPECTED_AUTHORIZATION));
    await expectAllSocketsReleased(server);
  });

  it("releases an unread streaming response even when a caller clones it", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    const { response, release } = await fetchCdpChecked(server.url, 1_000);
    const clone = response.clone();
    let released = false;
    const releasing = release();
    void releasing
      .finally(() => {
        released = true;
      })
      .catch(() => {});

    expect(clone.bodyUsed).toBe(false);
    await vi.waitFor(
      () => {
        expect(released).toBe(true);
      },
      { timeout: 1_250, interval: 20 },
    );
    await releasing;

    expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
    await expectAllSocketsReleased(server);
  });

  it("closes a partially consumed response while its stream reader remains locked", async () => {
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: true });
    const { response, release } = await fetchCdpChecked(server.url, 1_000);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("expected the authenticated CDP response to expose a readable stream");
    }
    const readerClosed = reader.closed.catch(() => {});
    const firstChunk = await reader.read();

    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.byteLength).toBeGreaterThan(0);
    expect(response.bodyUsed).toBe(true);
    await release();

    expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
    await expectAllSocketsReleased(server);
    await readerClosed;
  });

  it.each([
    { status: 503, error: /HTTP 503/ },
    { status: 429, error: /rate[ -]?limit/i },
  ])("closes unread streaming HTTP $status responses", async ({ status, error }) => {
    const server = await startAuthenticatedCdpServer({ status, streaming: true });
    await expect(fetchCdpChecked(server.url, 1_000)).rejects.toThrow(error);
    expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
    await expectAllSocketsReleased(server);
  });

  it("preserves authenticated CDP JSON responses with tuple headers", async () => {
    const headers: HeadersInit = [["Authorization", EXPECTED_AUTHORIZATION]];
    const server = await startAuthenticatedCdpServer({ status: 200, streaming: false });
    const url = new URL(server.url);
    url.password = "wrong-url-credential";
    await expect(fetchJson(url.toString(), 1_000, { headers })).resolves.toEqual({
      Browser: "OpenClaw transport fixture",
    });

    expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
  });
});
