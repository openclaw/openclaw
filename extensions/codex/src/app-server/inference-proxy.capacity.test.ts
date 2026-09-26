// Register transport mocks before SDK consumers load.
// oxfmt-ignore
import {
  child,
  clients,
  complete,
  connect,
  holdHttpResponses,
  holdUploads,
  open,
  post,
  prewarm,
  proxy,
  relayServer,
  send,
  server,
  transport,
  upstreams,
} from "./inference-proxy.capacity-test-support.js";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createConnection, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";

describe("inference relay capacity", () => {
  it("admits new root, child and HTTP fallback after 16 completed prewarm connections", async () => {
    for (let index = 0; index < 16; index++) {
      const { client, upstream } = await open();
      await send(client, upstream, prewarm);
      await complete(client, upstream);
    }
    expect((await post()).status).toBe(200);
    const { client, upstream } = await open();
    const registration = proxy.context.register({
      threadId: "root",
      text: "synthetic persona",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await send(client, upstream, {
      type: "response.create",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "root",
          request_kind: "turn",
          [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
        }),
      },
    });
    await complete(client, upstream);
    const childStream = await open();
    await send(childStream.client, childStream.upstream);
    await complete(childStream.client, childStream.upstream);
    expect(clients.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("starts another inference and HTTP fallback while 16 responses are still active", async () => {
    const streams = [];
    for (let index = 0; index < 16; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream);
      streams.push(stream);
    }
    const next = await open();
    await send(next.client, next.upstream, prewarm);
    expect((await post()).status).toBe(200);
    expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
    expect(upstreams).toHaveLength(17);
    // No terminal has been sent for the first batch when the next request arrives.
    for (const stream of [...streams, next]) {
      await complete(stream.client, stream.upstream);
    }
  });

  it("starts a WebSocket request while 16 HTTP responses are still streaming", async () => {
    const http = holdHttpResponses();
    const responses = Array.from({ length: 16 }, () => post());
    await http.waitFor(16);
    const next = await open();
    await send(next.client, next.upstream);
    await complete(next.client, next.upstream);
    for (const stream of http.streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every((response) => response.status === 200)).toBe(true);
  });

  it("reclaims the oldest idle transport immediately when its pool is full", async () => {
    for (let index = 0; index < 64; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const oldest = clients[0];
    assert(oldest);
    const closed = once(oldest, "close");
    const replacement = await open();
    await closed;
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    expect(clients.slice(1).every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
    expect((await post()).status).toBe(200);
  });

  it("reclaims completed WebSockets for HTTP pressure without a 16-response bottleneck", async () => {
    for (let index = 0; index < 64; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const http = holdHttpResponses();
    const responses = Array.from({ length: 16 }, () => post());
    await http.waitFor(16);
    const closed = once(clients[0]!, "close");
    responses.push(post());
    await Promise.all([closed, http.waitFor(17)]);
    expect(clients.slice(1).every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
    for (const stream of http.streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("keeps a new handshake until its first response completes under resident pressure", async () => {
    for (let index = 0; index < 63; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream);
    }
    const http = holdHttpResponses();
    const responses = Array.from({ length: 16 }, () => post());
    await http.waitFor(16);
    const resolving = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      resolving.resolve();
      return dns.promise;
    });
    const fresh = connect();
    const opened = once(fresh, "open");
    await resolving.promise;
    const incoming = once(relayServer(), "request");
    responses.push(post());
    await incoming;
    dns.resolve({ lookup: undefined });
    await opened;
    const upstream = upstreams.at(-1)!;
    await send(fresh, upstream);
    expect(fresh.readyState).toBe(WebSocket.OPEN);
    const closed = once(fresh, "close");
    await complete(fresh, upstream);
    await Promise.all([closed, http.waitFor(17)]);
    for (const stream of http.streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("bounds resident HTTP operations at 80 plus 16 waiters and recovers after cancellation", async () => {
    const http = holdHttpResponses();
    const responses = [];
    for (let index = 0; index < 80; index += 16) {
      responses.push(...Array.from({ length: 16 }, () => post()));
      await http.waitFor(responses.length);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const controllers = Array.from({ length: 16 }, () => new AbortController());
      const waiting = [];
      const closed = [];
      for (const controller of controllers) {
        const incoming = once(relayServer(), "request");
        waiting.push(post(controller.signal).catch(() => undefined));
        const [req] = await incoming;
        closed.push(once(req.socket, "close"));
      }
      expect(await post()).toMatchObject({ status: 503, retryAfter: "1" });
      expect(transport.fetch).toHaveBeenCalledTimes(80);
      for (const controller of controllers) {
        controller.abort();
      }
      await Promise.all(closed);
      expect(await Promise.all(waiting)).toEqual(Array(16).fill(undefined));
    }
    http.streams[0]!.close();
    const firstResponse = responses[0];
    assert(firstResponse);
    expect((await firstResponse).status).toBe(200);
    responses.push(post());
    await http.waitFor(81);
    for (const stream of http.streams.slice(1)) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("holds residency through physical upstream closure after a cancelled handshake", async () => {
    const http = holdHttpResponses();
    const responseController = new AbortController();
    const responses: ReturnType<typeof post>[] = [];
    let completedResponses = 0;
    const startHttp = () =>
      post(responseController.signal).then((response) => {
        completedResponses++;
        return response;
      });
    const destroyStarted = createDeferred<void>();
    const allowDestroy = createDeferred<void>();
    const upstreamSocket = new (class extends Socket {
      override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        destroyStarted.resolve();
        // Hold the actual socket destruction, not only its completion callback.
        // oxlint-disable-next-line eslint/no-underscore-dangle -- Node documents _destroy as the custom stream teardown hook.
        void allowDestroy.promise.then(() => super._destroy(error, callback));
      }
    })();
    try {
      for (let index = 0; index < 79; index += 16) {
        responses.push(...Array.from({ length: Math.min(16, 79 - index) }, startHttp));
        await http.waitFor(responses.length);
      }
      const received = createDeferred<void>();
      const peerClosed = createDeferred<void>();
      server.removeAllListeners("upgrade");
      server.once("upgrade", (_request, socket) => {
        socket.once("close", () => peerClosed.resolve());
        socket.once("end", () => socket.end());
        socket.on("error", () => {});
        socket.resume();
        received.resolve();
      });
      const logicalClosed = createDeferred<void>();
      let requestClosed = false;
      let socketClosed = false;
      const target = new URL(transport.upstream);
      transport.upstreamOptions = (options) => ({
        ...options,
        createConnection: () =>
          upstreamSocket.connect({ host: target.hostname, port: Number(target.port) }),
        finishRequest(upstreamRequest, websocket) {
          upstreamRequest.once("socket", (socket) => {
            socket.once("close", () => {
              socketClosed = true;
            });
          });
          upstreamRequest.once("close", () => {
            requestClosed = true;
          });
          // A CONNECTING websocket emits error before its logical close.
          websocket.once("close", () => logicalClosed.resolve());
          assert(options.finishRequest);
          options.finishRequest(upstreamRequest, websocket);
        },
      });
      const upgrade = once(relayServer(), "upgrade");
      const client = connect();
      const [, downstream] = await upgrade;
      await received.promise;
      const fetch = transport.fetch.getMockImplementation();
      assert(fetch);
      const replacement = createDeferred<{
        requestClosed: boolean;
        socketClosed: boolean;
        calls: number;
      }>();
      transport.fetch.mockImplementationOnce((args) => {
        replacement.resolve({
          requestClosed,
          socketClosed,
          calls: transport.fetch.mock.calls.length,
        });
        return fetch(args);
      });
      const incoming = once(relayServer(), "request");
      responses.push(startHttp());
      await incoming;
      const downstreamClosed = once(downstream, "close");
      client.terminate();
      await Promise.all([downstreamClosed, logicalClosed.promise, destroyStarted.promise]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      // Logical WS closure and downstream cleanup cannot release the 80th slot
      // while its real upstream socket is still waiting to be destroyed.
      expect(upstreamSocket.closed).toBe(false);
      expect(requestClosed).toBe(false);
      expect(socketClosed).toBe(false);
      expect(completedResponses).toBe(0);
      expect(http.streams).toHaveLength(79);
      expect(transport.fetch).toHaveBeenCalledTimes(79);
      allowDestroy.resolve();
      expect(await replacement.promise).toEqual({
        requestClosed: true,
        socketClosed: true,
        calls: 80,
      });
      await Promise.all([http.waitFor(80), peerClosed.promise]);
      for (const stream of http.streams) {
        stream.close();
      }
      expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
    } finally {
      allowDestroy.resolve();
      responseController.abort();
      await Promise.allSettled(responses);
    }
  });

  it("charges pipelined HTTP operations independently on a shared downstream socket", async () => {
    const http = holdHttpResponses();
    const responses = [];
    for (let index = 0; index < 79; index += 16) {
      responses.push(...Array.from({ length: Math.min(16, 79 - index) }, () => post()));
      await http.waitFor(responses.length);
    }
    const target = new URL(proxy.baseUrl + "/responses");
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    const body = JSON.stringify(child);
    const wire = `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    let incoming = 0;
    const received = createDeferred<void>();
    relayServer().on("request", () => {
      if (++incoming === 2) {
        received.resolve();
      }
    });
    socket.write(wire + wire);
    await Promise.all([received.promise, http.waitFor(80)]);
    expect(transport.fetch).toHaveBeenCalledTimes(80);
    http.streams[0]!.close();
    await responses[0];
    await http.waitFor(81);
    for (const stream of http.streams.slice(1, 79)) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
  });

  it("cancels every fully read pipelined request when its shared socket closes", async () => {
    if (process.env.OPENCLAW_VITEST_RUNTIME === "bun") {
      expect(process.versions.bun).toBeTruthy();
    }
    console.info("inference pipeline worker", {
      pid: process.pid,
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    });
    const started = createDeferred<void>();
    const backpressured = createDeferred<void>();
    const released = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let responseBytes = 0;
    let releaseCount = 0;
    transport.fetch.mockImplementation(async (args) => {
      await new Response(args.init.body).arrayBuffer();
      signals.push(args.signal);
      if (signals.length === 2) {
        started.resolve();
      }
      return {
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (signals.length === 2) {
                controller.enqueue(new Uint8Array(responseBytes));
              }
            },
          }),
        ),
        release: async () => {
          if (++releaseCount === 2) {
            released.resolve();
          }
        },
      };
    });
    const incoming: IncomingMessage[] = [];
    relayServer().on("request", (req, res) => {
      incoming.push(req);
      if (incoming.length === 2) {
        responseBytes = res.writableHighWaterMark + 1;
        const write = res.write.bind(res);
        vi.spyOn(res, "write").mockImplementation((chunk, encoding, callback) => {
          const accepted = write(chunk, encoding, callback);
          if (!accepted) {
            backpressured.resolve();
          }
          return accepted;
        });
      }
    });
    const target = new URL(proxy.baseUrl + "/responses");
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    const body = JSON.stringify(child);
    const wire = `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    socket.write(wire + wire);
    await Promise.all([started.promise, backpressured.promise]);
    expect(incoming).toHaveLength(2);
    expect(incoming.every((req) => req.complete && req.readableEnded)).toBe(true);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const closed = once(incoming[0]!.socket, "close");
    socket.destroy();
    await closed;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await released.promise;
  }, 5_000);

  it("retains upload admission after early headers until the final body chunk's next pull", async () => {
    const uploads: ReadableStream<Uint8Array>[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const arrived = new EventEmitter();
    transport.fetch.mockImplementation(async (args) => {
      uploads.push(args.init.body);
      arrived.emit("request");
      return {
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              controller.enqueue(new TextEncoder().encode("early response"));
            },
          }),
        ),
        release: async () => {},
      };
    });
    const responses = Array.from({ length: 16 }, () => post());
    while (uploads.length < 16) {
      await once(arrived, "request");
    }
    const reader = uploads[0]!.getReader();
    expect((await reader.read()).done).toBe(false);
    const incoming = once(relayServer(), "request");
    responses.push(post());
    await incoming;
    expect(transport.fetch).toHaveBeenCalledTimes(16);
    const next = once(arrived, "request");
    expect((await reader.read()).done).toBe(true);
    await next;
    expect(transport.fetch).toHaveBeenCalledTimes(17);
    await Promise.all(uploads.slice(1).map((body) => new Response(body).arrayBuffer()));
    for (const stream of streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("does not evict a completed response until its final frame has drained", async () => {
    const active = await open();
    await send(active.client, active.upstream);
    const downstream = transport.downstreams[0];
    assert(downstream);
    const nativeSend = downstream.send.bind(downstream);
    let drained: (() => void) | undefined;
    vi.spyOn(downstream, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => {
        drained = () => callback?.(error);
      });
    });
    await complete(active.client, active.upstream);
    for (let index = 0; index < 63; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const oldestIdle = clients[1];
    assert(oldestIdle);
    const evicted = Promise.race([
      once(active.client, "close").then(() => "active"),
      once(oldestIdle, "close").then(() => "idle"),
    ]);
    await open();
    expect(await evicted).toBe("idle");
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    expect(drained).toBeTypeOf("function");
    drained?.();
  });

  it("bounds pending handshakes before dialing and drains without leaking permits", async () => {
    const pending: (() => void)[] = [];
    const admitted = createDeferred<void>();
    transport.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ lookup: undefined }));
          if (pending.length === 16) {
            admitted.resolve();
          }
        }),
    );
    let upgrades = 0;
    const queued = createDeferred<void>();
    relayServer().on("upgrade", () => {
      if (++upgrades === 32) {
        queued.resolve();
      }
    });
    const opened = Array.from({ length: 32 }, () => once(connect(), "open"));
    await admitted.promise;
    await queued.promise;
    const rejected = connect();
    const [, response] = await once(rejected, "unexpected-response");
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
      status: 503,
      error: { code: "inference_relay_busy" },
    });
    expect(upstreams).toHaveLength(0);
    transport.resolve.mockResolvedValue({ lookup: undefined });
    for (const resolve of pending) {
      resolve();
    }
    await Promise.all(opened);
    expect(upstreams).toHaveLength(32);
    expect((await post()).status).toBe(200);
  });

  it("admits 16 uploads and 16 queued frames from one synchronous arrival batch", async () => {
    const streams = [];
    const releases: (() => void)[] = [];
    const busy: number[] = [];
    for (let index = 0; index < 33; index++) {
      const stream = await open();
      const nativeSend = stream.remote.send.bind(stream.remote);
      vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
        nativeSend(data, options, (error) => releases.push(() => callback?.(error)));
      });
      stream.client.on("message", () => busy.push(index));
      streams.push(stream);
    }
    const first = streams.slice(0, 16).map(({ upstream }) => once(upstream, "message"));
    const second = streams.slice(16, 32).map(({ upstream }) => once(upstream, "message"));
    const rejected = once(streams[32]!.client, "message");
    for (const downstream of transport.downstreams) {
      // Deliver a single event-loop batch at the real WS message boundary.
      downstream.emit("message", Buffer.from(JSON.stringify(child)), false);
    }
    expect(JSON.parse((await rejected)[0].toString())).toMatchObject({ status: 503 });
    await Promise.all(first);
    expect(busy).toEqual([32]);
    expect(releases).toHaveLength(16);
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(second);
    for (const release of releases.splice(0)) {
      release();
    }
  });

  it("keeps a late old send callback from releasing the next frame's upload", async () => {
    const reused = await open();
    const nativeSend = reused.remote.send.bind(reused.remote);
    const callbacks: (() => void)[] = [];
    vi.spyOn(reused.remote, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => callbacks.push(() => callback?.(error)));
    });
    await send(reused.client, reused.upstream);
    await complete(reused.client, reused.upstream);
    await send(reused.client, reused.upstream);
    expect(callbacks).toHaveLength(2);
    // Occupy the other 14 uploads; the same connection currently owns two callbacks.
    const held: (() => void)[] = [];
    for (let index = 0; index < 14; index++) {
      const stream = await open();
      const sendNow = stream.remote.send.bind(stream.remote);
      vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
        sendNow(data, options, (error) => held.push(() => callback?.(error)));
      });
      await send(stream.client, stream.upstream);
    }
    const firstCallback = callbacks[0]!;
    const received = once(relayServer(), "request");
    const waiting = post();
    await received;
    expect(transport.fetch).not.toHaveBeenCalled();
    firstCallback();
    expect((await waiting).status).toBe(200);
    // An idempotent old callback cannot release the second frame again.
    firstCallback();
    callbacks[1]!();
    for (const release of held) {
      release();
    }
    await complete(reused.client, reused.upstream);
    // Both original leases must be gone; releasing a mutable newer handle would
    // leave the old frame charged and prevent a complete replacement batch.
    for (const stream of await holdUploads()) {
      stream.releaseUpload();
    }
  });

  it("keeps cancelled native decompression charged until its callback settles", async () => {
    const started = createDeferred<void>();
    const jobs: (() => void)[] = [];
    transport.decompressions = jobs;
    transport.decompressionStarted = () => {
      if (jobs.length === 16) {
        started.resolve();
      }
    };
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const closed = [];
    const cancelled = [];
    for (const controller of controllers) {
      const incoming = once(relayServer(), "request");
      cancelled.push(post(controller.signal, true).catch(() => undefined));
      const [req] = await incoming;
      closed.push(once(req.socket, "close"));
    }
    await started.promise;
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all([...cancelled, ...closed]);
    const replacements = [];
    for (let index = 0; index < 16; index++) {
      const incoming = once(relayServer(), "request");
      replacements.push(post(undefined, true));
      await incoming;
    }
    // The next request observes the still-full upload queue. Abort cannot cancel
    // a zlib callback already running outside the relay's JavaScript continuation.
    expect((await post()).status).toBe(503);
    expect(jobs).toHaveLength(16);
    transport.decompressions = undefined;
    for (const finish of jobs.splice(0)) {
      finish();
    }
    expect((await Promise.all(replacements)).every(({ status }) => status === 200)).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(16);
  });

  it("expires a queued handshake before native connect timeout without dialing upstream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await holdUploads();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const rejected = once(queued, "unexpected-response");
    await upgrade;
    await vi.advanceTimersByTimeAsync(10_000);
    const [, response] = await rejected;
    response.resume();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(upstreams).toHaveLength(16);
  });

  it("bounds queued HTTP work, cancels waiters, and admits a later request", async () => {
    const streams = await holdUploads();
    for (let cycle = 0; cycle < 3; cycle++) {
      const controllers = Array.from({ length: 16 }, () => new AbortController());
      const waiting = [];
      const disconnected = [];
      for (const controller of controllers) {
        const received = once(relayServer(), "request");
        waiting.push(post(controller.signal).catch(() => undefined));
        const [incoming] = await received;
        disconnected.push(once(incoming.socket, "close"));
      }
      expect(await post()).toMatchObject({ status: 503, retryAfter: "1" });
      for (const controller of controllers) {
        controller.abort();
      }
      await Promise.all(disconnected);
      expect(await Promise.all(waiting)).toEqual(Array(16).fill(undefined));
    }
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    expect((await post()).status).toBe(200);
    expect(transport.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a queued handshake on peer FIN before capacity becomes available", async () => {
    const streams = await holdUploads();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const [, socket] = await upgrade;
    const ended = once(socket, "end");
    queued.terminate();
    await ended;
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    // HTTP admission is a FIFO barrier after the cancelled handshake's slot.
    expect((await post()).status).toBe(200);
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(socket.destroyed).toBe(true);
  });

  it.each(["generation revoked", "duplicate frame"])(
    "releases queued work after %s without forwarding it or blocking the next frame",
    async (cause) => {
      for (let cycle = 0; cycle < 3; cycle++) {
        const offset = transport.downstreams.length;
        const stale = await open();
        const next = await open();
        const streams = await holdUploads();
        const registration = proxy.context.register({
          threadId: "root",
          text: "synthetic persona",
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        const staleReceived = once(transport.downstreams[offset]!, "message");
        stale.client.send(
          JSON.stringify({
            type: "response.create",
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: "root",
                request_kind: "turn",
                [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
              }),
            },
          }),
        );
        await staleReceived;
        const staleForwarded = vi.fn();
        stale.upstream.on("message", staleForwarded);
        const closed = once(stale.client, "close");
        if (cause === "generation revoked") {
          registration.release();
        } else {
          stale.client.send(JSON.stringify(child));
        }
        await closed;
        const nextReceived = once(transport.downstreams[offset + 1]!, "message");
        const forwarded = once(next.upstream, "message");
        next.client.send(JSON.stringify(child));
        await nextReceived;
        const first = streams[0];
        assert(first);
        first.releaseUpload();
        await forwarded;
        expect(staleForwarded).not.toHaveBeenCalled();
        await complete(next.client, next.upstream);
        for (const stream of streams) {
          stream.releaseUpload();
        }
        registration.release();
        const closedSockets: Promise<unknown>[] = [];
        for (const stream of [stale, next, ...streams]) {
          for (const socket of [stream.client, stream.upstream]) {
            if (socket.readyState !== WebSocket.CLOSED) {
              closedSockets.push(once(socket, "close"));
            }
          }
          stream.client.terminate();
        }
        await Promise.all(closedSockets);
      }
    },
  );

  it.each(["timer", "clock"])(
    "expires admission during DNS by %s without leaking the permit",
    async (expiry) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const started = createDeferred<void>();
      const dns = createDeferred<{ lookup: undefined }>();
      transport.resolve.mockImplementationOnce(() => {
        started.resolve();
        return dns.promise;
      });
      const stalled = connect();
      const rejected = once(stalled, "unexpected-response");
      await started.promise;
      if (expiry === "timer") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else {
        // DNS can settle after the deadline before the queued timer callback runs.
        vi.setSystemTime(Date.now() + 10_000);
        dns.resolve({ lookup: undefined });
      }
      const [, response] = await rejected;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.from(chunk));
      }
      expect(response.statusCode).toBe(504);
      expect(Buffer.concat(chunks).toString()).toBe(
        "Codex parent-local inference transport failed; retry on a fresh connection.",
      );
      dns.resolve({ lookup: undefined });
      const streams = await holdUploads();
      expect(upstreams).toHaveLength(16);
      expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
    },
  );

  it("bounds queued frame bytes and recovers after disconnect", async () => {
    const large = await open();
    const excess = await open();
    const streams = await holdUploads();
    const body = JSON.stringify({ ...child, input: "x".repeat(17 * 1024 * 1024) });
    const received = once(transport.downstreams[0]!, "message");
    large.client.send(body);
    await received;
    const rejected = once(excess.client, "message");
    excess.client.send(body);
    expect(JSON.parse((await rejected)[0].toString())).toMatchObject({ status: 503 });
    const closed = once(transport.downstreams[0]!, "close");
    large.client.terminate();
    await closed;
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    expect((await post()).status).toBe(200);
  });

  it.each([
    { phase: "upgrade", expiry: "timer" },
    { phase: "error body", expiry: "timer" },
    { phase: "error body", expiry: "clock" },
  ])(
    "expires a stalled upstream $phase by $expiry and reclaims admission",
    async ({ phase, expiry }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const handlers = server.listeners("upgrade");
      server.removeAllListeners("upgrade");
      const received = createDeferred<void>();
      const disconnected = createDeferred<void>();
      let finishBody = () => {};
      server.once("upgrade", (_request, socket) => {
        socket.once("close", () => disconnected.resolve());
        // Raw HTTP-upgrade sockets retain a writable half after peer FIN.
        socket.once("end", () => socket.end());
        socket.on("error", (error) => expect(error).toMatchObject({ code: "ECONNRESET" }));
        if (phase === "error body") {
          socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 1000\r\n\r\nx");
          finishBody = () => socket.end("x".repeat(999));
        }
        received.resolve();
      });
      const stalled = connect();
      const rejected = once(stalled, "unexpected-response");
      const closed = new Promise<void>((resolve) => {
        stalled.once("close", () => resolve());
      });
      await received.promise;
      if (expiry === "timer") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else {
        vi.setSystemTime(Date.now() + 10_000);
        finishBody();
      }
      const [, response] = await rejected;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.from(chunk));
      }
      expect(response.statusCode).toBe(504);
      expect(Buffer.concat(chunks).toString()).toBe(
        "Codex parent-local inference transport failed; retry on a fresh connection.",
      );
      stalled.terminate();
      await Promise.all([closed, disconnected.promise]);
      for (const handler of handlers) {
        server.on("upgrade", handler);
      }
      expect(await holdUploads()).toHaveLength(16);
    },
  );

  it("flushes a timely provider rejection after the handshake deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    server.removeAllListeners("upgrade");
    server.once("upgrade", (_request, socket) => {
      socket.on("error", () => {});
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\n\r\ndenied");
    });
    const upgrade = once(relayServer(), "upgrade");
    const client = connect();
    const rejected = once(client, "unexpected-response");
    const [, downstream] = await upgrade;
    const selected = createDeferred<void>();
    const end = downstream.end.bind(downstream);
    let flush = () => {};
    vi.spyOn(downstream, "end").mockImplementation((...args) => {
      flush = () => end(...args);
      selected.resolve();
      return downstream;
    });
    await selected.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downstream.destroyed).toBe(false);
    flush();
    const [, response] = await rejected;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(401);
    expect(Buffer.concat(chunks).toString()).toBe("denied");
  });

  it("expires only proven idle connections, not active streams, then admits their replacements", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idle = await open();
    await send(idle.client, idle.upstream, prewarm);
    await complete(idle.client, idle.upstream);
    const active = await open();
    await send(active.client, active.upstream);
    await complete(active.client, active.upstream, '{"type":"response.completed"}');
    await complete(active.client, active.upstream, '{"type":"error","message":"unknown event"}');
    const closed = once(idle.client, "close");
    await vi.advanceTimersByTimeAsync(60_000);
    await closed;
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    await complete(
      active.client,
      active.upstream,
      '{"type":"response.output_text.delta","delta":"alive"}',
    );
    const replacement = await open();
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    await complete(active.client, active.upstream);
  });
});
