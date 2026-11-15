import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawDataToText } from "./client-websocket.test-support.js";
import { CodexAppServerClient } from "./client.js";
import * as processRegistration from "./transport-process-registration.js";
import { createWebSocketTransport } from "./transport-websocket.js";

describe("Codex app-server websocket transport", () => {
  const clients: CodexAppServerClient[] = [];
  const transports: Array<ReturnType<typeof createWebSocketTransport>> = [];
  const servers: WebSocketServer[] = [];
  const httpServers: http.Server[] = [];
  const tempDirs: string[] = [];

  async function startClient(
    server: WebSocketServer,
    options: Parameters<typeof CodexAppServerClient.start>[0] = {},
  ) {
    const client = await CodexAppServerClient.start({
      transport: "websocket",
      url: options.url ?? (await websocketUrl(server)),
      ...options,
    });
    clients.push(client);
    return client;
  }

  const rejectLocalInspection = () =>
    vi
      .spyOn(processRegistration, "prepareCodexAppServerProcessRegistration")
      .mockRejectedValue(new Error("local inspection unavailable"));

  function tcpServer(autoPong = true) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong });
    servers.push(server);
    return server;
  }

  async function heartbeatFixture(autoPong = true) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = tcpServer(autoPong);
    const connected = createDeferred<void>();
    const ping = createDeferred<void>();
    server.once("connection", (socket) => {
      socket.once("ping", () => ping.resolve());
      socket.once("message", () => connected.resolve());
    });
    const transport = createTransport(await websocketUrl(server));
    transport.stdin.write("{}\n");
    await connected.promise;
    return { transport, receivedPing: ping.promise };
  }

  function createTransport(url: string, kind: "websocket" | "unix" = "websocket") {
    const transport = createWebSocketTransport({
      transport: kind,
      command: "codex",
      args: [],
      url,
      headers: {},
    });
    transports.push(transport);
    return transport;
  }

  async function websocketUrl(server: WebSocketServer | http.Server) {
    if (!server.address()) {
      await once(server, "listening");
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  async function frameFixture() {
    const server = tcpServer();
    const message = createDeferred<string>();
    server.once("connection", (socket) => {
      socket.once("message", (data) => message.resolve(rawDataToText(data)));
      socket.send("{}");
    });
    const transport = createTransport(await websocketUrl(server));
    await once(transport.stdout, "data");
    return { transport, message: message.promise };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients.splice(0)) {
      client.close();
    }
    for (const transport of transports.splice(0)) {
      transport.kill?.();
      transport.stdin.destroy?.();
    }
    for (const server of servers) {
      for (const socket of server.clients) {
        socket.terminate();
      }
    }
    await Promise.all(
      [...servers.splice(0), ...httpServers.splice(0)].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("authenticates websocket connections without local process inspection", async () => {
    const localRegistration = rejectLocalInspection();
    const server = tcpServer();
    const connected = once(server, "connection");
    await startClient(server, { authToken: "secret" });
    const [, request] = await connected;
    expect(request.headers.authorization).toBe("Bearer secret");
    expect(localRegistration).not.toHaveBeenCalled();
  });

  it("forces socket shutdown when the peer cannot finish the close handshake", async () => {
    const server = tcpServer();
    server.once("connection", (socket) => {
      socket.once("message", () => {
        socket.pause();
        socket.send(JSON.stringify({ method: "probe/ready" }));
      });
    });
    const client = await startClient(server);
    const received = createDeferred<void>();
    client.addNotificationHandler(() => received.resolve());
    client.notify("probe");
    await received.promise;
    const disposedExitHandler = vi.fn();
    client.addTransportExitHandler(disposedExitHandler)();
    await expect(
      client.closeAndWait({ forceKillDelayMs: 10, exitTimeoutMs: 1_000 }),
    ).resolves.toEqual({ exited: true, cleanup: "uncertain" });
    expect(disposedExitHandler).not.toHaveBeenCalled();
  });

  it("keeps an idle remote websocket healthy with protocol-level ping frames", async () => {
    const { transport, receivedPing } = await heartbeatFixture();

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(receivedPing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(transport.killed).toBe(false);
  });

  it("closes a remote websocket only after five consecutive unanswered pings", async () => {
    const { transport, receivedPing } = await heartbeatFixture(false);
    const exited = createDeferred<unknown>();
    transport.once("exit", exited.resolve);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(receivedPing).resolves.toBeUndefined();

    for (let missedPongs = 1; missedPongs < 5; missedPongs += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(transport.killed).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(exited.promise).resolves.toBe(1006);
    expect(transport.killed).toBe(true);
  });

  it("surfaces a rejected HTTP websocket upgrade", async () => {
    const httpServer = http.createServer((_request, response) => {
      response.writeHead(401).end();
    });
    httpServers.push(httpServer);
    httpServer.listen(0, "127.0.0.1");
    const transport = createTransport(await websocketUrl(httpServer));
    const error = createDeferred<unknown>();
    transport.once("error", error.resolve);
    await expect(error.promise).resolves.toHaveProperty(
      "message",
      "Unexpected server response: 401",
    );
  });

  it("preserves UTF-8 JSON-RPC bytes split across writable chunks", async () => {
    const { transport, message } = await frameFixture();
    const frame = Buffer.from('{"jsonrpc":"2.0","method":"😀"}\n');
    const emojiStart = frame.indexOf(Buffer.from("😀"));
    transport.stdin.write(frame.subarray(0, emojiStart + 2));
    transport.stdin.write(frame.subarray(emojiStart + 2));
    await expect(message).resolves.toBe('{"jsonrpc":"2.0","method":"😀"}');
  });

  it("flushes an unterminated JSON-RPC frame when stdin finishes", async () => {
    const { transport, message } = await frameFixture();
    transport.stdin.write('{"jsonrpc":"2.0","method":"final"}');
    transport.stdin.end?.();
    await expect(message).resolves.toBe('{"jsonrpc":"2.0","method":"final"}');
  }, 5_000);

  it("can speak JSON-RPC over the canonical unix control socket", async () => {
    // macOS socket paths must fit sockaddr_un even when the runner nests TMPDIR.
    const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const tempDir = await mkdtemp(path.join(tempRoot, "openclaw-codex-unix-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "app-server.sock");
    const httpServer = http.createServer();
    httpServers.push(httpServer);
    // Bind before ws forwards HTTP errors, so a listen failure rejects this test.
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });
    const server = new WebSocketServer({ server: httpServer });
    servers.push(server);
    const upgradeExtensions: Array<string | string[] | undefined> = [];
    server.once("connection", (socket, request) => {
      upgradeExtensions.push(request.headers["sec-websocket-extensions"]);
      socket.once("message", (data) => socket.send(rawDataToText(data)));
    });
    const transport = createTransport(`unix://${socketPath}`, "unix");
    const received = once(transport.stdout, "data");
    const message = '{"id":1,"method":"thread/list","params":{}}';
    transport.stdin.write(`${message}\n`);
    const [frame] = await received;
    expect(String(frame).trim()).toBe(message);
    expect(upgradeExtensions).toEqual([undefined]);
  });
});
