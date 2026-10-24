import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

type Mode = "empty" | "idle";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startDaemon(mode: Mode): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "empty") {
      // signal-cli 0.14.9 answers the event endpoint with an empty 200 body.
      res.end();
    } else {
      res.flushHeaders();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runUntil(mode: Mode, stop: (patch: { lifecycle?: string }) => boolean) {
  const baseUrl = await startDaemon(mode);
  const abort = new AbortController();
  const runtime = createRuntimeSpies();
  const patches: Array<{ lifecycle?: string; lastError?: string | null }> = [];
  const statusSink = vi.fn((patch: { lifecycle?: string; lastError?: string | null }) => {
    patches.push(patch);
    if (stop(patch)) {
      abort.abort();
    }
  });
  const loop = runSignalSseLoop({
    baseUrl,
    abortSignal: abort.signal,
    runtime,
    onEvent: vi.fn(),
    statusSink,
    policy: { initialMs: 10, maxMs: 10, jitter: 0 },
  });
  return { abort, loop, patches, runtime };
}

describe("runSignalSseLoop over HTTP", () => {
  it("reports an empty 200 event stream as a lost connection", async () => {
    const { loop, patches, runtime } = await runUntil(
      "empty",
      (patch) => patch.lifecycle === "recovering",
    );
    await loop;

    expect(patches.at(-1)).toMatchObject({
      lifecycle: "recovering",
      connected: false,
      lastError: expect.stringContaining("closed the event stream without sending any events"),
    });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Signal connection lost (Signal daemon closed the event stream"),
    );
  });

  it.each(["idle stream", "intentional abort"] as const)("keeps the %s quiet", async (scenario) => {
    const { abort, loop, patches, runtime } = await runUntil("idle", () => false);
    await vi.waitFor(() =>
      expect(patches).toContainEqual(expect.objectContaining({ lifecycle: "ready" })),
    );
    if (scenario === "idle stream") {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    abort.abort();
    await loop;

    expect(patches).not.toContainEqual(expect.objectContaining({ lifecycle: "recovering" }));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("connection lost"));
  });
});
