import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import * as processRegistration from "./transport-process-registration.js";
import { createWebSocketTransport } from "./transport-websocket.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

describe("Codex app-server websocket transport", () => {
  const clients: CodexAppServerClient[] = [];
  const transports: Array<ReturnType<typeof createWebSocketTransport>> = [];
  const servers: WebSocketServer[] = [];
  const httpServers: http.Server[] = [];
  const tempDirs: string[] = [];
  const rawServers: net.Server[] = [];
  const acceptedSockets: net.Socket[] = [];

  async function listenNeverUpgradePeer(mode: "tcp" | "unix"): Promise<{
    url?: string;
    socketPath?: string;
    destroyAccepted: () => void;
  }> {
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);

    if (mode === "tcp") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const { port } = server.address() as AddressInfo;
      return {
        url: `ws://127.0.0.1:${port}`,
        destroyAccepted: () => {
          for (const socket of accepted) {
            socket.destroy();
          }
        },
      };
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-unix-hs-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "never-upgrade.sock");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    return {
      socketPath,
      destroyAccepted: () => {
        for (const socket of accepted) {
          socket.destroy();
        }
      },
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    for (const transport of transports.splice(0)) {
      transport.kill?.();
      transport.stdin.destroy?.();
    }
    for (const socket of acceptedSockets.splice(0)) {
      socket.destroy();
    }
    for (const server of servers) {
      for (const socket of server.clients) {
        socket.terminate();
      }
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await Promise.all(
      httpServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      rawServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("can speak JSON-RPC over websocket transport", async () => {
    const localRegistration = vi
      .spyOn(processRegistration, "prepareCodexAppServerProcessRegistration")
      .mockRejectedValue(new Error("local inspection unavailable"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION}` },
            }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const client = await CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
      authToken: "secret",
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("model/list", {})).resolves.toEqual({ data: [] });
    expect(authHeaders).toEqual(["Bearer secret"]);
    expect(localRegistration).not.toHaveBeenCalled();

    const disposedExitHandler = vi.fn();
    client.addTransportExitHandler(disposedExitHandler)();
    const exited = new Promise<void>((resolve) => {
      client.addTransportExitHandler(() => resolve());
    });
    for (const socket of server.clients) {
      socket.close(1001, "server restarting");
    }
    await exited;
    expect.soft(disposedExitHandler).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(client.closeAndWait({ exitTimeoutMs: 50 })).resolves.toEqual({
        exited: true,
        cleanup: "uncertain",
      });
    }
  });

  it("forces socket shutdown when the peer cannot finish the close handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    server.once("connection", (socket) => {
      socket.once("message", () => {
        socket.pause();
        socket.send(JSON.stringify({ method: "probe/ready" }));
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const client = await CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
    });
    clients.push(client);
    const received = new Promise<void>((resolve) => {
      client.addNotificationHandler(() => resolve());
    });
    client.notify("probe");
    await received;
    await expect(
      client.closeAndWait({ forceKillDelayMs: 10, exitTimeoutMs: 1_000 }),
    ).resolves.toEqual({ exited: true, cleanup: "uncertain" });
  });

  it("keeps an idle remote websocket healthy with protocol-level ping frames", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    let resolvePing: (() => void) | undefined;
    const receivedPing = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    server.once("connection", (socket) => {
      socket.once("ping", () => resolvePing?.());
      socket.once("message", () => resolveConnected?.());
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }

    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    transports.push(transport);
    transport.stdin.write("{}\n");
    await connected;

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(receivedPing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(transport.killed).toBe(false);
  });

  it("closes a remote websocket only after five consecutive unanswered pings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
    servers.push(server);
    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    let resolvePing: (() => void) | undefined;
    const receivedPing = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    server.once("connection", (socket) => {
      socket.once("ping", () => resolvePing?.());
      socket.once("message", () => resolveConnected?.());
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }

    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    transports.push(transport);
    const exited = new Promise<unknown>((resolve) => {
      transport.once("exit", (code) => resolve(code));
    });
    transport.stdin.write("{}\n");
    await connected;

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(receivedPing).resolves.toBeUndefined();

    for (let missedPongs = 1; missedPongs < 5; missedPongs += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(transport.killed).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(exited).resolves.toBe(1006);
    expect(transport.killed).toBe(true);
  });

  it.each([401, 403])("surfaces a rejected HTTP %i websocket upgrade", async (statusCode) => {
    const httpServer = http.createServer((_request, response) => {
      response.writeHead(statusCode);
      response.end();
    });
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }

    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    transports.push(transport);
    const connectionError = new Promise<unknown>((resolve) => {
      transport.once("error", (error) => resolve(error));
    });

    await expect(connectionError).resolves.toHaveProperty(
      "message",
      `Unexpected server response: ${statusCode}`,
    );
  });

  it("preserves UTF-8 JSON-RPC bytes split across writable chunks", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    let resolveConnection: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnection = resolve;
    });
    let resolveMessage: ((message: string) => void) | undefined;
    const message = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    server.once("connection", (socket) => {
      socket.once("message", (data) => resolveMessage?.(rawDataToText(data)));
      resolveConnection?.();
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    transports.push(transport);
    await connected;
    const frame = Buffer.from('{"jsonrpc":"2.0","method":"😀"}\n');
    const emojiStart = frame.indexOf(Buffer.from("😀"));
    transport.stdin.write(frame.subarray(0, emojiStart + 2));
    transport.stdin.write(frame.subarray(emojiStart + 2));
    await expect(message).resolves.toBe('{"jsonrpc":"2.0","method":"😀"}');
  });

  it("flushes an unterminated JSON-RPC frame when stdin finishes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    let resolveMessage: ((message: string) => void) | undefined;
    const message = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    server.once("connection", (socket) => {
      socket.once("message", (data) => resolveMessage?.(rawDataToText(data)));
      socket.send("{}");
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    transports.push(transport);
    const clientReady = new Promise<void>((resolve) => {
      transport.stdout.once("data", () => resolve());
    });
    await clientReady;
    transport.stdin.write('{"jsonrpc":"2.0","method":"final"}');
    transport.stdin.end?.();
    await expect(message).resolves.toBe('{"jsonrpc":"2.0","method":"final"}');
  }, 5_000);

  it("can speak JSON-RPC over the canonical unix control socket", async () => {
    const localRegistration = vi
      .spyOn(processRegistration, "prepareCodexAppServerProcessRegistration")
      .mockRejectedValue(new Error("local inspection unavailable"));
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
    const upgradeExtensions: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      upgradeExtensions.push(request.headers["sec-websocket-extensions"]);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION}` },
            }),
          );
          return;
        }
        if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });

    const client = await CodexAppServerClient.start({
      transport: "unix",
      homeScope: "user",
      url: `unix://${socketPath}`,
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(upgradeExtensions).toEqual([undefined]);
    expect(localRegistration).not.toHaveBeenCalled();
  });

  it("negative control: ws without handshakeTimeout stays CONNECTING on never-upgrade peer", async () => {
    const peer = await listenNeverUpgradePeer("tcp");
    const socket = new WebSocket(peer.url!);
    const outcome = await Promise.race([
      new Promise<"opened">((resolve) => {
        socket.once("open", () => resolve("opened"));
      }),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 300);
      }),
    ]);
    expect(outcome).toBe("still-pending");
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    socket.on("error", () => {});
    socket.terminate();
    peer.destroyAccepted();
  });

  it.each([
    { mode: "tcp" as const, handshakeTimeoutMs: 200 },
    { mode: "unix" as const, handshakeTimeoutMs: 250 },
  ])(
    "emits exit when the $mode websocket handshake never completes",
    async ({ mode, handshakeTimeoutMs }) => {
      const peer = await listenNeverUpgradePeer(mode);
      const transport = createWebSocketTransport(
        mode === "tcp"
          ? { transport: "websocket", url: peer.url! }
          : { transport: "unix", url: `unix://${peer.socketPath!}` },
        { handshakeTimeoutMs },
      );
      transports.push(transport);

      const startedAt = Date.now();
      const exitResult = await new Promise<{ code: number | null; reason: string }>((resolve) => {
        transport.once("exit", (code, reason) => {
          resolve({
            code: typeof code === "number" ? code : null,
            reason: typeof reason === "string" ? reason : "",
          });
        });
      });
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(2_000);
      expect(elapsedMs).toBeGreaterThanOrEqual(handshakeTimeoutMs - 100);
      expect(transport.killed).toBe(true);
      expect(exitResult.code).toBe(1006);
      peer.destroyAccepted();
    },
  );
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
