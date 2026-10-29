import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop, type SignalStatusSink } from "./sse-reconnect.js";

const servers: Server[] = [];

async function startRejectingSignalServer(
  status: number,
  statusMessage: string,
  onRequest?: (requestCount: number) => void,
) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    onRequest?.(requests);
    response.statusMessage = statusMessage;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("rejected\n");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("runSignalSseLoop native HTTP boundary", () => {
  it.each([
    ["empty ID", "id: \n\n", undefined],
    ["NUL ID", "id: bad\0id\ndata: notification\n\n", "1"],
    ["no ID", "data: notification\n\n", "1"],
    ["incomplete frame", "id: 2\ndata: incomplete\n", "1"],
  ])("preserves accepted cursor semantics across %s", async (_name, frame, expectedCursor) => {
    const headers: Array<string | string[] | undefined> = [];
    const abort = new AbortController();
    const server = createServer((request, response) => {
      headers.push(request.headers["last-event-id"]);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(headers.length === 1 ? "id: 1\ndata: first\n\n" : frame);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    await runSignalSseLoop({
      baseUrl: `http://127.0.0.1:${address.port}`,
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      onEvent: () => {},
      policy: { initialMs: 0, maxMs: 0, jitter: 0 },
      statusSink: (patch) => {
        if (headers.length === 3 && patch.lifecycle === "recovering") {
          abort.abort();
        }
      },
    });
    expect(headers).toEqual([undefined, "1", expectedCursor]);
  });

  it("publishes one terminal status and stops after a permanent rejection", async () => {
    const abort = new AbortController();
    const endpoint = await startRejectingSignalServer(400, "Bad Request", (requestCount) => {
      if (requestCount === 2) {
        abort.abort();
      }
    });
    const statusSink = vi.fn<SignalStatusSink>();

    await runSignalSseLoop({
      baseUrl: endpoint.baseUrl,
      account: "+15555550100",
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(endpoint.requestCount()).toBe(1);
    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledWith({
      lifecycle: "blocked",
      terminalDisconnect: true,
      connected: false,
      lastError:
        "Signal daemon rejected the event stream: Signal SSE failed (400 Bad Request). Check the configured account and daemon URL, fix the daemon or proxy response, then restart the channel.",
    });
  });

  it("keeps reconnecting after a transient HTTP rejection", async () => {
    const endpoint = await startRejectingSignalServer(503, "Try Again Later");
    const abort = new AbortController();
    const patches: Array<Omit<ChannelAccountSnapshot, "accountId">> = [];

    await runSignalSseLoop({
      baseUrl: endpoint.baseUrl,
      account: "+15555550100",
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      onEvent: vi.fn(),
      policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      statusSink: (patch) => {
        patches.push(patch);
        if (endpoint.requestCount() === 2) {
          abort.abort();
        }
      },
    });

    expect(endpoint.requestCount()).toBe(2);
    expect(patches).toHaveLength(2);
    expect(patches).toEqual([
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    ]);
    expect(patches).not.toContainEqual(expect.objectContaining({ terminalDisconnect: true }));
  });
});
