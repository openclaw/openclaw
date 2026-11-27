import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFaceTimeAvatarFeed, type FaceTimeAvatarFeed } from "../src/avatar-feed.js";

const pluginRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

// 100 ms of a loud 300 Hz tone: five complete lip-sync hops.
function speech(): Buffer {
  const audio = Buffer.alloc(2_400 * 2);
  for (let index = 0; index < 2_400; index += 1) {
    audio.writeInt16LE(
      Math.round(12_000 * Math.sin((2 * Math.PI * 300 * index) / 24_000)),
      index * 2,
    );
  }
  return audio;
}

describe("FaceTime avatar feed", () => {
  let feed: FaceTimeAvatarFeed;
  let server: Server;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    feed = createFaceTimeAvatarFeed({ pluginRoot });
    server = createServer((req, res) => void feed.handleRequest(req, res));
    server.on("upgrade", (req, socket, head) => feed.handleUpgrade(req, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    feed.close();
    server.close();
    await once(server, "close");
  });

  const get = (method: string, headers: IncomingHttpHeaders = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/facetime/avatar", method, headers });
      req.on("error", fail);
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.end();
    });

  // Messages are queued from the first byte so a test cannot miss one sent before it awaits.
  const watch = (headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/facetime/avatar`, { headers });
    sockets.push(socket);
    const queue: unknown[] = [];
    const waiters: Array<(message: unknown) => void> = [];
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(rawDataToString(data));
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queue.push(message);
      }
    });
    return {
      socket,
      next: () =>
        new Promise<unknown>((done) => {
          if (queue.length > 0) {
            done(queue.shift());
          } else {
            waiters.push(done);
          }
        }),
      closed: new Promise<number>((done) => {
        socket.on("close", (code) => done(code));
        socket.on("unexpected-response", (_req, res) => done(res.statusCode ?? 0));
        socket.on("error", () => undefined);
      }),
    };
  };

  it("serves the shipped avatar page with a policy that forbids external loads", async () => {
    const page = await get("GET");

    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("<canvas");
    expect(page.body).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/iu);
    expect((await get("POST")).status).toBe(405);
  });

  it("streams call state and scheduled mouth shapes to a viewer and closes the mouth on clear", async () => {
    const viewer = watch();
    expect(await viewer.next()).toEqual({ type: "hello", now: expect.any(Number), call: "idle" });

    feed.sink.setCallActive(true);
    feed.sink.setCallActive(true);
    feed.sink.speak(speech(), 1_700_000_000_123.4);
    feed.sink.clear();
    feed.sink.setCallActive(false);

    expect(await viewer.next()).toEqual({ type: "call", state: "active" });
    const speak = (await viewer.next()) as { frames: number[] };
    expect(speak).toEqual({
      type: "speak",
      at: 1_700_000_000_123,
      hopMs: 20,
      frames: expect.any(Array),
    });
    expect(speak.frames).toHaveLength(10);
    expect(speak.frames[0]).toBeGreaterThan(50);
    expect(await viewer.next()).toEqual({ type: "clear" });
    expect(await viewer.next()).toEqual({ type: "call", state: "idle" });

    // A viewer that connects mid-call learns the current state from its first message.
    feed.sink.setCallActive(true);
    expect(await watch().next()).toMatchObject({ type: "hello", call: "active" });
  });

  it("closes a viewer that sends anything, without disturbing the others", async () => {
    const talker = watch();
    const listener = watch();
    await Promise.all([talker.next(), listener.next()]);

    talker.socket.send("anything");
    expect(await talker.closed).toBe(1003);

    feed.sink.clear();
    expect(await listener.next()).toEqual({ type: "clear" });
  });

  it.each<Record<string, string>>([
    { "x-forwarded-for": "203.0.113.7" },
    { forwarded: "for=203.0.113.7" },
  ])("refuses a viewer that arrives through a proxy (%j)", async (headers) => {
    expect((await get("GET", headers)).status).toBe(403);
    expect(await watch(headers).closed).toBe(403);
  });
});
