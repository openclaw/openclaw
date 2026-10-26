import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { fetchCdpChecked, fetchJson, fetchOk } from "./cdp.helpers.js";

const credentials = "openclaw:browser-cdp-transport-test";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(credentials).toString("base64")}`;

async function startServer(status = 200, streaming = true) {
  const sockets = new Set<Socket>();
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== EXPECTED_AUTHORIZATION) {
      response.writeHead(401).end();
      return;
    }

    response.writeHead(status, { "content-type": "application/json" });
    if (streaming) {
      // Keep the response body open until the actual CDP client cancels it.
      response.write('{"Browser":');
      return;
    }
    response.end(JSON.stringify({ Browser: "OpenClaw transport fixture" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const port = await listenOnLoopback(server);

  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        sockets.forEach((socket) => socket.destroy());
      }),
  );
  return {
    url: `http://${credentials}@127.0.0.1:${port}/json/version`,
    sockets,
    authorizations,
  };
}

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 1_250, interval: 20 });

async function expectReleased(server: Awaited<ReturnType<typeof startServer>>, requests = 1) {
  expect(server.authorizations).toEqual(Array(requests).fill(EXPECTED_AUTHORIZATION));
  await waitFor(() => expect(server.sockets.size).toBe(0));
}

it("closes every unread streaming response after concurrent status probes", async () => {
  const server = await startServer();
  await Promise.all(Array.from({ length: 8 }, () => fetchOk(server.url, 1_000)));

  await expectReleased(server, 8);
});

it("releases an unread streaming response even when a caller clones it", async () => {
  const server = await startServer();
  const { response, release } = await fetchCdpChecked(server.url, 1_000);
  const clone = response.clone();
  const released = vi.fn();
  const releasing = release().finally(released);
  void releasing.catch(() => {});

  expect(clone.bodyUsed).toBe(false);
  await waitFor(() => expect(released).toHaveBeenCalledOnce());
  await releasing;

  await expectReleased(server);
});

it("closes a partially consumed response while its stream reader remains locked", async () => {
  const server = await startServer();
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

  await expectReleased(server);
  await readerClosed;
});

it.each([
  { status: 503, error: /HTTP 503/ },
  { status: 429, error: /rate[ -]?limit/i },
])("closes unread streaming HTTP $status responses", async ({ status, error }) => {
  const server = await startServer(status);
  await expect(fetchCdpChecked(server.url, 1_000)).rejects.toThrow(error);
  await expectReleased(server);
});

it("preserves authenticated CDP JSON responses with tuple headers", async () => {
  const headers: HeadersInit = [["Authorization", EXPECTED_AUTHORIZATION]];
  const server = await startServer(200, false);
  const url = new URL(server.url);
  url.password = "wrong-url-credential";
  await expect(fetchJson(url.toString(), 1_000, { headers })).resolves.toEqual({
    Browser: "OpenClaw transport fixture",
  });

  expect(server.authorizations).toEqual([EXPECTED_AUTHORIZATION]);
});
