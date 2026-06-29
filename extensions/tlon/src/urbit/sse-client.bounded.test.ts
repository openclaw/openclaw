// Tlon Urbit SSE bounded-read real wire proof (loopback http.createServer).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

describe("UrbitSSEClient processStream bounded-read real wire proof", () => {
  it("caps an oversized body streamed chunked over real wire", async () => {
    const CHUNK = 1024 * 1024;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent < 18) {
          res.write(Buffer.alloc(CHUNK));
          sent++;
        } else {
          clearInterval(tick);
          res.end();
        }
      }, 1);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const fetchRes = await fetch(`http://127.0.0.1:${port}/`);
      const client = new UrbitSSEClient(`http://127.0.0.1:${port}`, "urbauth-~zod=123", {
        autoReconnect: false,
      });

      let captured: Error | undefined;
      try {
        await client.processStream(fetchRes.body);
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).toBeInstanceOf(Error);
      const match = (captured as Error).message.match(
        /tlon Urbit SSE: body exceeds (\d+) bytes \(got (\d+)\)/,
      );
      expect(match).not.toBeNull();
      const cap = Number(match![1]);
      const got = Number(match![2]);
      expect(cap).toBe(MAX);
      // Loopback TCP framing can coalesce the final packet, so the reported
      // size at throw time is somewhere between MAX (cap fired) and TOTAL
      // (server's full body) — both bounds prove (a) cap fired (got > MAX)
      // and (b) we did not buffer beyond the server's full 18 MiB (got < TOTAL).
      expect(got).toBeGreaterThan(MAX);
      expect(got).toBeLessThan(TOTAL);
      console.log(
        `[tlon SSE bounded-read proof] oversized path: cap=${MAX} reported=${got} server_total=${TOTAL}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns and dispatches events for normal-size SSE body on real wire", async () => {
    const eventText = 'data: {"json":{"hello":"world"}}\n\n' + 'data: {"json":{"foo":"bar"}}\n\n';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(eventText);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const fetchRes = await fetch(`http://127.0.0.1:${port}/`);
      const received: unknown[] = [];
      const client = new UrbitSSEClient(`http://127.0.0.1:${port}`, "urbauth-~zod=123", {
        autoReconnect: false,
        logger: { log: () => {}, error: () => {} },
      });
      // One subscription handler. Each JSON payload without an `id` field
      // hits the broadcast branch (processEvent line 316-321), so every
      // event fires this single handler exactly once.
      void client.subscribe({
        app: "chat",
        path: "/dm-inbox",
        event: (data) => received.push(data),
      });
      await client.processStream(fetchRes.body);
      expect(received).toEqual([{ hello: "world" }, { foo: "bar" }]);
      console.log(`[tlon SSE bounded-read proof] normal path: events received=${received.length}`);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
