// Codex tests cover transport websocket plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient } from "./client.js";
import { createWebSocketTransport } from "./transport-websocket.js";

/** Matches production CODEX_APP_SERVER_WS_HANDSHAKE_TIMEOUT_MS / requestTimeoutMs default. */
const EXPECTED_HANDSHAKE_TIMEOUT_MS = 60_000;

describe("Codex app-server websocket transport", () => {
  const clients: CodexAppServerClient[] = [];
  const transports: Array<ReturnType<typeof createWebSocketTransport>> = [];
  const servers: WebSocketServer[] = [];
  const httpServers: http.Server[] = [];
  const tempDirs: string[] = [];
  const rawServers: net.Server[] = [];
  const acceptedSockets: net.Socket[] = [];

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    for (const transport of transports) {
      transport.kill?.();
    }
    transports.length = 0;
    for (const socket of acceptedSockets.splice(0)) {
      socket.destroy();
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
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.143.0" } }),
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
    const client = CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
      authToken: "secret",
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("model/list", {})).resolves.toEqual({ data: [] });
    expect(authHeaders).toEqual(["Bearer secret"]);
  });

  it("can speak JSON-RPC over the canonical unix control socket", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-unix-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "app-server.sock");
    const httpServer = http.createServer();
    httpServers.push(httpServer);
    const server = new WebSocketServer({ server: httpServer });
    servers.push(server);
    const upgradeExtensions: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      upgradeExtensions.push(request.headers["sec-websocket-extensions"]);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.144.1" } }),
          );
          return;
        }
        if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const client = CodexAppServerClient.start({
      transport: "unix",
      homeScope: "user",
      url: `unix://${socketPath}`,
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(upgradeExtensions).toEqual([undefined]);
  });

  it("negative control: ws without handshakeTimeout stays CONNECTING on never-upgrade peer", async () => {
    // Pre-fix shape: plain `ws.WebSocket` with no handshakeTimeout against a
    // TCP-accept / never-upgrade peer stays CONNECTING and never emits open.
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
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
    console.log(
      `[codex handshake negative control] outcome=${outcome} readyState=${String(socket.readyState)} wait_ms=300 without_handshakeTimeout=true`,
    );
    // terminate() aborts the handshake which can emit 'error' from the
    // underlying request; suppress so it does not surface as an unhandled error.
    socket.on("error", () => {});
    socket.terminate();
    for (const peer of accepted) {
      peer.destroy();
    }
  });

  it("emits exit when the websocket handshake never completes", async () => {
    // Accept TCP but never complete the websocket upgrade so missing
    // handshakeTimeout would leave initialize/RPC waiting forever for open.
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    // Short non-default floor for hang repro; production uses resolved
    // requestTimeoutMs (default 60s) via CodexAppServerClient.start.
    const transport = createWebSocketTransport(
      {
        transport: "websocket",
        url: `ws://127.0.0.1:${port}`,
      },
      { handshakeTimeoutMs: 200 },
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
    expect(transport.killed).toBe(true);
    expect(exitResult.code).toBe(1006);
    console.log(
      `[codex handshake proof] timed_out=true elapsed_ms=${elapsedMs} code=${String(exitResult.code)} handshakeTimeout_ms=200 production_ms=${EXPECTED_HANDSHAKE_TIMEOUT_MS}`,
    );

    for (const socket of accepted) {
      socket.destroy();
    }
  });

  it("honors a non-default handshake budget on the TCP transport path", async () => {
    // Non-default budget (not the 60s requestTimeoutMs default) on the shared
    // builder used by both TCP and Unix construction paths.
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    const transport = createWebSocketTransport(
      {
        transport: "websocket",
        url: `ws://127.0.0.1:${port}`,
      },
      { handshakeTimeoutMs: 250 },
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
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(transport.killed).toBe(true);
    expect(exitResult.code).toBe(1006);
    console.log(
      `[codex handshake tcp non-default] timed_out=true elapsed_ms=${elapsedMs} code=${String(exitResult.code)} handshakeTimeout_ms=250`,
    );

    for (const socket of accepted) {
      socket.destroy();
    }
  });

  it("honors a non-default handshake budget on the Unix transport path", async () => {
    // ws.handshakeTimeout alone does not abort createConnection upgrades; the
    // explicit CONNECTING deadline must fire on this path too.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-unix-hs-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "never-upgrade.sock");
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    const transport = createWebSocketTransport(
      {
        transport: "unix",
        url: `unix://${socketPath}`,
      },
      { handshakeTimeoutMs: 250 },
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
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(transport.killed).toBe(true);
    expect(exitResult.code).toBe(1006);
    console.log(
      `[codex handshake unix non-default] timed_out=true elapsed_ms=${elapsedMs} code=${String(exitResult.code)} handshakeTimeout_ms=250`,
    );

    for (const socket of accepted) {
      socket.destroy();
    }
  });

  it("fails initialize when the websocket handshake never completes", async () => {
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      acceptedSockets.push(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    const transport = createWebSocketTransport(
      {
        transport: "websocket",
        url: `ws://127.0.0.1:${port}`,
      },
      { handshakeTimeoutMs: 200 },
    );
    const client = CodexAppServerClient.fromTransportForTests(transport);
    clients.push(client);

    const startedAt = Date.now();
    const outcome = await client.initialize().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(2_000);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(Error);
      console.log(
        `[codex handshake initialize proof] timed_out=true elapsed_ms=${elapsedMs} message=${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`,
      );
    }

    for (const socket of accepted) {
      socket.destroy();
    }
  });
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
