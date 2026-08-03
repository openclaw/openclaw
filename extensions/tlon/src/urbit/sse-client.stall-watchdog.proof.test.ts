// Tlon stall-watchdog proof: a real HTTP server that stops sending SSE bytes
// after the first heartbeat forces the real client to reconnect on its own.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const STALL_TIMEOUT_MS = 300;
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

const runningServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of runningServers) {
    // Without a watchdog the first stalled stream never ends; close its sockets
    // so a failed assertion still lets the suite exit instead of hanging.
    server.closeAllConnections?.();
  }
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("UrbitSSEClient SSE stall watchdog proof", () => {
  it("reconnects when the real SSE server stops sending bytes", async () => {
    const requests: string[] = [];
    let streamGets = 0;
    const server = createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      requests.push(`${method} ${url}`);
      if (method === "PUT" || method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && url.startsWith("/~/channel/")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        streamGets += 1;
        const safeWrite = (chunk: string) => {
          try {
            res.write(chunk);
          } catch {
            // The watchdog aborts the socket; ignore the write-after-close noise.
          }
        };
        // Eyre sends an immediate heartbeat so clients treat the stream as open.
        safeWrite(":\n\n");
        if (streamGets >= 2) {
          // The second stream delivers one real event, then goes silent again.
          safeWrite('data: {"id":1,"json":{"ok":true}}\n\n');
        }
        // Leave the response open without further bytes: a silent TCP stall.
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    runningServers.push(server);
    const address = server.address() as AddressInfo;

    const log: string[] = [];
    const errors: string[] = [];
    const client = new UrbitSSEClient(`http://127.0.0.1:${address.port}`, "urbauth-~zod=proof", {
      ship: "zod",
      stallTimeoutMs: STALL_TIMEOUT_MS,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      logger: { log: (message) => log.push(message), error: (message) => errors.push(message) },
    });
    const handler = vi.fn();
    await client.subscribe({ app: "chat", path: "/dm/~zod", event: handler });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await client.connect();

      // First stream stalls; the watchdog must trigger its own reconnect.
      await vi.waitFor(
        () => {
          expect(requests.filter((entry) => entry.startsWith("GET /~/channel/"))).toHaveLength(2);
        },
        { timeout: 5_000 },
      );

      expect(errors.some((message) => message.includes("Stream stalled"))).toBe(true);
      expect(log.some((message) => message.includes("stalled, attempting reconnection"))).toBe(
        true,
      );
      // The second stream delivered the queued event before stalling again.
      await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ ok: true }), {
        timeout: 5_000,
      });

      await client.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandledRejections).toStrictEqual([]);
  });

  it("does not abort a healthy stream while a handler runs longer than stallTimeoutMs", async () => {
    let streamGets = 0;
    const server = createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "PUT" || method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && url.startsWith("/~/channel/")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        streamGets += 1;
        // One real event, then keep heartbeating so the connection stays alive.
        res.write('data: {"id":1,"json":{"event":true}}\n\n');
        const heartbeat = setInterval(() => {
          try {
            res.write(":\n\n");
          } catch {
            clearInterval(heartbeat);
          }
        }, 50);
        res.on("close", () => clearInterval(heartbeat));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    runningServers.push(server);
    const address = server.address() as AddressInfo;

    const log: string[] = [];
    const errors: string[] = [];
    const client = new UrbitSSEClient(`http://127.0.0.1:${address.port}`, "urbauth-~zod=proof", {
      ship: "zod",
      stallTimeoutMs: STALL_TIMEOUT_MS,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      logger: { log: (message) => log.push(message), error: (message) => errors.push(message) },
    });
    // A handler that runs well past stallTimeoutMs must not count as a stall.
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 500);
      });
    });
    await client.subscribe({ app: "chat", path: "/dm/~zod", event: handler });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await client.connect();

      // The event is dispatched (handler returns after ~500ms > 300ms timeout).
      await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ event: true }), {
        timeout: 5_000,
      });
      // Wait past the stall timeout: without the suspend, the watchdog would
      // abort during the slow handler and this client would reconnect.
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), STALL_TIMEOUT_MS * 2);
      });
      expect(streamGets).toBe(1);
      expect(errors.some((message) => message.includes("Stream stalled"))).toBe(false);

      await client.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandledRejections).toStrictEqual([]);
  });
});
