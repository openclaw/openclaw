import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, type AddressInfo, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { closeOpenAILiveSocket } from "./realtime-quicksilver-protocol.js";
import { OpenAIQuicksilverWorkerSocket } from "./realtime-quicksilver-socket.js";

// Timestamp on an independent receiver loop while the Gateway is blocked.
const receiverSource =
  "const { parentPort, workerData } = require('node:worker_threads');\nconst { fileURLToPath } = require('node:url');\nconst { WebSocketServer } = require(fileURLToPath(workerData.wsUrl));\nconst counts = new Int32Array(workerData.count);\nconst times = new Float64Array(workerData.times);\nconst outputCounts = new Int32Array(workerData.outputCount);\nconst outputState = new Int32Array(workerData.outputState);\nworkerData.outputPort.on('message', message => {\n  if (message.type === 'audio') {\n    if (Atomics.load(outputState, 0) === 0 && message.audio instanceof Uint8Array && message.audio.byteLength === 960 && message.audio[0] === 1 && message.audio[1] === 1) Atomics.add(outputCounts, 0, 1);\n    workerData.outputPort.postMessage({ type: 'ack' });\n  }\n});\nconst server = new WebSocketServer({ host: '127.0.0.1', port: 0 });\nserver.on('connection', socket => socket.on('message', data => {\n  const event = JSON.parse(data.toString());\n  if (event.type === 'session.input_audio.append') {\n    const index = Atomics.load(counts, 0);\n    times[index] = performance.now();\n    Atomics.store(counts, 0, index + 1);\n    socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: event.audio }));\n  }\n  if (event.type === 'session.close') {\n    socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'final transcript', start_ms: 0, end_ms: 100 }));\n    socket.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested' }));\n  }\n}));\nserver.on('listening', () => parentPort.postMessage('ws://127.0.0.1:' + server.address().port));";

describe("GPT-Live socket worker", () => {
  it("keeps actual PCM packets paced during a blocked Gateway and drains final transcripts", async () => {
    const count = new Int32Array(new SharedArrayBuffer(4));
    const times = new Float64Array(new SharedArrayBuffer(4096 * 8));
    const outputCount = new Int32Array(new SharedArrayBuffer(4));
    const outputState = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const callbackAudio: Buffer[] = [];
    const wsRequire = createRequire(createRequire(import.meta.url).resolve("ws/package.json"));
    const receiver = new Worker(receiverSource, {
      eval: true,
      workerData: {
        count: count.buffer,
        times: times.buffer,
        wsUrl: pathToFileURL(wsRequire.resolve("./index.js")).href,
        outputPort: port2,
        outputCount: outputCount.buffer,
        outputState,
      },
      transferList: [port2],
    });
    const errors: Error[] = [];
    let direct: OpenAIQuicksilverWorkerSocket | undefined;
    try {
      const [url] = await once(receiver, "message");
      direct = OpenAIQuicksilverWorkerSocket.create(
        String(url),
        { headers: { Authorization: "Bearer synthetic-fixture" }, maxPayload: 16 * 1024 * 1024 },
        { model: "gpt-live-1", paced: true },
        { onAudio: (audio) => callbackAudio.push(audio) },
      );
      direct.on("error", (error) => errors.push(error));
      await once(direct, "open");
      direct.setAudioOutputPort({ port: port1, state: outputState });
      const frames: string[] = [];
      direct.on("message", (data) => frames.push(data.toString()));
      direct.sendAudio(Buffer.alloc(240_000, 1));
      direct.startAudio();
      await waitForPackets(count, 5);
      await waitForPackets(outputCount, 5);
      const beforeOutput = Atomics.load(outputCount, 0);
      const beforeWorker = Atomics.load(count, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const afterWorker = Atomics.load(count, 0);
      const workerDuringStall = afterWorker - beforeWorker;
      const outputDuringStall = Atomics.load(outputCount, 0) - beforeOutput;
      const gaps = Array.from(
        { length: Math.max(0, workerDuringStall - 1) },
        (_, index) => times[beforeWorker + index + 1]! - times[beforeWorker + index]!,
      );
      expect(workerDuringStall).toBeGreaterThanOrEqual(10);
      expect(outputDuringStall).toBeGreaterThanOrEqual(10);
      expect(callbackAudio).toEqual([]);
      expect(Math.max(...gaps)).toBeLessThan(180);
      direct.stopAudio();
      expect(Atomics.load(new Int32Array(outputState), 0)).toBe(1);
      await expect(closeOpenAILiveSocket(direct)).resolves.toBe("close_requested");
      expect(frames.map((frame) => JSON.parse(frame).type)).toEqual([
        "session.input_transcript.delta",
        "session.closed",
      ]);
      expect(errors).toEqual([]);
    } finally {
      direct?.close();
      port1.close();
      port2.close();
      await receiver.terminate();
    }
  }, 30_000);

  it("retires a worker closed before WebSocket startup without late open or audio", async () => {
    const opened: string[] = [];
    const audio: Buffer[] = [];
    const socket = OpenAIQuicksilverWorkerSocket.create(
      "ws://127.0.0.1:1",
      { maxPayload: 1024 },
      { model: "gpt-live-1", paced: true },
      { onAudio: (chunk) => audio.push(chunk) },
    );
    socket.once("open", () => opened.push("open"));
    socket.on("error", () => {});
    const closed = once(socket, "close");
    socket.sendAudio(Buffer.alloc(960));
    socket.close();
    socket.close();
    await closed;
    socket.startAudio();
    socket.sendAudio(Buffer.alloc(960));
    expect(opened).toEqual([]);
    expect(audio).toEqual([]);
    expect(socket.readyState).toBe(3);
  }, 10_000);
});

// Managed proxy hooks live only in the Gateway isolate; the media worker sees the env.
describe("GPT-Live socket worker managed proxy", () => {
  it("tunnels media through the managed proxy and exchanges audio", async () => {
    const target = await startAudioEchoTarget();
    const proxy = await startForwardProxy(true);
    stubManagedProxyEnv(proxy.url, "gateway-only");
    // Only the proxy reaches this host, like api.openai.com behind egress restrictions.
    const authority = `gpt-live.openai.test:${target.port}`;
    const audio: Buffer[] = [];
    const errors: Error[] = [];
    const { promise: firstAudio, resolve: echoed } = Promise.withResolvers<void>();
    const socket = OpenAIQuicksilverWorkerSocket.create(
      `ws://${authority}`,
      { maxPayload: 1024 * 1024 },
      { model: "gpt-live-1", paced: true },
      {
        onAudio: (chunk) => {
          audio.push(chunk);
          echoed();
        },
      },
    );
    socket.on("error", (error) => errors.push(error));
    try {
      const startup = await settleStartup(socket);
      expect(proxy.connects).toEqual([authority]);
      expect(startup).toBe("open");
      socket.sendAudio(Buffer.alloc(960, 1));
      socket.startAudio();
      await firstAudio;
      expect(audio[0]).toEqual(Buffer.alloc(960, 1));
      const closed = once(socket, "close");
      socket.close();
      await closed;
      expect(errors).toEqual([]);
    } finally {
      socket.close();
      await Promise.all([target.close(), proxy.close()]);
    }
  }, 10_000);

  it("fails closed without a direct connection when the proxy refuses the tunnel", async () => {
    const target = await startAudioEchoTarget();
    const proxy = await startForwardProxy(false);
    // Loopback mode "proxy" keeps this target directly reachable, so a fallback would connect.
    stubManagedProxyEnv(proxy.url, "proxy");
    const authority = `127.0.0.1:${target.port}`;
    const errors: Error[] = [];
    const socket = OpenAIQuicksilverWorkerSocket.create(
      `ws://${authority}`,
      { maxPayload: 1024 },
      { model: "gpt-live-1", paced: true },
      { onAudio: () => {} },
    );
    socket.on("error", (error) => errors.push(error));
    try {
      expect(await settleStartup(socket)).toBe("close");
      expect(proxy.connects).toEqual([authority]);
      expect(errors).toHaveLength(1);
      expect(target.connections()).toBe(0);
    } finally {
      socket.close();
      await Promise.all([target.close(), proxy.close()]);
    }
  }, 10_000);
});

// Mirrors the env startProxy exports for runtimes that cannot share its hooks.
function stubManagedProxyEnv(proxyUrl: string, loopbackMode: "gateway-only" | "proxy"): void {
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
    vi.stubEnv(key, proxyUrl);
  }
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
  vi.stubEnv("OPENCLAW_PROXY_LOOPBACK_MODE", loopbackMode);
  vi.stubEnv("OPENCLAW_PROXY_CA_FILE", undefined);
  for (const key of ["no_proxy", "NO_PROXY"]) {
    vi.stubEnv(
      key,
      loopbackMode === "gateway-only" ? "127.0.0.1,localhost,localhost.,::1,[::1],127.0.0.0/8" : "",
    );
  }
}

function settleStartup(socket: OpenAIQuicksilverWorkerSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve("open"));
    socket.once("close", () => resolve("close"));
  });
}

async function startAudioEchoTarget() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const event = JSON.parse(rawDataToString(data)) as { type: string; audio?: string };
      if (event.type === "session.input_audio.append") {
        socket.send(JSON.stringify({ type: "session.output_audio.delta", delta: event.audio }));
      }
    });
  });
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    close: async () => {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function startForwardProxy(admit: boolean) {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connection", (socket) => sockets.add(socket));
  server.on("connect", (request, client: Socket, head: Buffer) => {
    const authority = request.url ?? "";
    connects.push(authority);
    if (!admit) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(Number(authority.split(":").at(-1)), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    connects,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function waitForPackets(count: Int32Array, minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Atomics.load(count, 0) < minimum && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  expect(Atomics.load(count, 0)).toBeGreaterThanOrEqual(minimum);
}
