import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const muxDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ADMIN_TOKEN = "test-admin-token";

type RunningServer = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  tempDir: string;
  cleanupTempDir: boolean;
};

type RunningHttpServer = {
  server: http.Server;
};

type RunningWsServer = {
  server: WebSocketServer;
};

const runningServers: RunningServer[] = [];
const runningHttpServers: RunningHttpServer[] = [];
const runningWsServers: RunningWsServer[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve test port"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolvePort(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`mux server did not become healthy on port ${port}`);
}

async function startServer(options?: {
  tempDir?: string;
  cleanupTempDir?: boolean;
  dbPath?: string;
  apiKey?: string;
  tenantsJson?: string;
  pairingCodesJson?: string;
  extraEnv?: Record<string, string>;
}): Promise<RunningServer> {
  const port = await getFreePort();
  const tempDir = options?.tempDir ?? mkdtempSync(resolve(tmpdir(), "mux-server-test-"));
  const cleanupTempDir = options?.cleanupTempDir ?? !options?.tempDir;
  const dbPath = options?.dbPath ?? resolve(tempDir, "mux-server.sqlite");
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: muxDir,
    env: {
      ...globalThis.process.env,
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "dummy-token",
      DISCORD_BOT_TOKEN: "dummy-discord-token",
      MUX_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN,
      MUX_API_KEY: options?.apiKey ?? "test-key",
      ...(options?.tenantsJson ? { MUX_TENANTS_JSON: options.tenantsJson } : {}),
      ...(options?.pairingCodesJson ? { MUX_PAIRING_CODES_JSON: options.pairingCodesJson } : {}),
      ...options?.extraEnv,
      MUX_PORT: String(port),
      MUX_LOG_PATH: resolve(tempDir, "mux-server.log"),
      MUX_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const running = { process: child, port, tempDir, cleanupTempDir };
  runningServers.push(running);
  await waitForHealth(port);
  return running;
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.process.exitCode === null && !server.process.killed) {
    server.process.kill("SIGINT");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        if (server.process.exitCode === null && !server.process.killed) {
          server.process.kill("SIGKILL");
        }
        resolveExit();
      }, 3_000);
      server.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  if (server.cleanupTempDir) {
    rmSync(server.tempDir, { recursive: true, force: true });
  }
}

function removeRunningServer(server: RunningServer) {
  const index = runningServers.indexOf(server);
  if (index >= 0) {
    runningServers.splice(index, 1);
  }
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: RunningHttpServer }> {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveServer();
    });
  });
  const running = { server };
  runningHttpServers.push(running);
  return { url: `http://127.0.0.1:${port}`, server: running };
}

async function stopHttpServer(running: RunningHttpServer): Promise<void> {
  await new Promise<void>((resolveServer) => {
    running.server.close(() => resolveServer());
  });
}

async function startWsServer(
  onConnection: (socket: WebSocket) => void | Promise<void>,
): Promise<{ url: string; server: RunningWsServer }> {
  const port = await getFreePort();
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  wsServer.on("connection", (socket) => {
    void onConnection(socket);
  });
  await new Promise<void>((resolveServer, reject) => {
    wsServer.once("listening", () => resolveServer());
    wsServer.once("error", reject);
  });
  const running = { server: wsServer };
  runningWsServers.push(running);
  return { url: `ws://127.0.0.1:${port}`, server: running };
}

async function stopWsServer(running: RunningWsServer): Promise<void> {
  await new Promise<void>((resolveServer) => {
    running.server.close(() => resolveServer());
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function toSafeString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function readHeaderString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
    return value[0].trim();
  }
  return null;
}

function readBearerToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid jwt format");
  }
  const payloadPart = parts[1] ?? "";
  const normalized = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function expectInboundJwtAuth(
  params: { authorization: unknown; openclawIdHeader: unknown },
  expectedOpenclawId: string,
) {
  expect(readHeaderString(params.openclawIdHeader)).toBe(expectedOpenclawId);
  const token = readBearerToken(params.authorization);
  expect(token).toBeTruthy();
  if (!token) {
    return;
  }
  const payload = decodeJwtPayload(token);
  expect(toSafeString(payload.sub)).toBe(expectedOpenclawId);
  const aud = payload.aud;
  const audiences = Array.isArray(aud)
    ? aud.map((entry) => toSafeString(entry)).filter(Boolean)
    : typeof aud === "string"
      ? [aud]
      : [];
  expect(audiences).toContain("openclaw-mux-inbound");
  expect(toSafeString(payload.scope)).toContain("mux:inbound");
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(errorMessage);
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    if (server) {
      await stopServer(server);
    }
  }
  while (runningHttpServers.length > 0) {
    const server = runningHttpServers.pop();
    if (server) {
      await stopHttpServer(server);
    }
  }
  while (runningWsServers.length > 0) {
    const server = runningWsServers.pop();
    if (server) {
      await stopWsServer(server);
    }
  }
});

function requestPayload(text: string) {
  return {
    channel: "telegram",
    sessionKey: "agent:main:telegram:group:-100123:topic:2",
    text,
  };
}

async function sendWithIdempotency(params: {
  port: number;
  apiKey: string;
  idempotencyKey: string;
  text: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/mux/outbound/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify(requestPayload(params.text)),
  });
}

async function claimPairing(params: {
  port: number;
  apiKey: string;
  code: string;
  sessionKey?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: params.code,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    }),
  });
}

async function listPairings(params: { port: number; apiKey: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings`, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
  });
}

async function unbindPairing(params: { port: number; apiKey: string; bindingId: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/unbind`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bindingId: params.bindingId }),
  });
}

async function getAdminWhatsAppHealth(params: { port: number; adminToken: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/whatsapp/health`, {
    headers: {
      Authorization: `Bearer ${params.adminToken}`,
    },
  });
}

async function createAdminPairingToken(params: {
  port: number;
  adminToken: string;
  openclawId: string;
  inboundUrl?: string;
  inboundTimeoutMs?: number;
  channel: string;
  sessionKey?: string;
  ttlSec?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/pairings/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      openclawId: params.openclawId,
      channel: params.channel,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.ttlSec ? { ttlSec: params.ttlSec } : {}),
      ...(params.inboundUrl ? { inboundUrl: params.inboundUrl } : {}),
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

async function registerInstance(params: {
  port: number;
  registerKey: string;
  openclawId: string;
  inboundUrl: string;
  inboundTimeoutMs?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/instances/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.registerKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      openclawId: params.openclawId,
      inboundUrl: params.inboundUrl,
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

describe("mux server", () => {
  test("health endpoint responds", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("instance register endpoint requires shared register key and returns runtime jwt metadata", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
      },
    });

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/instances/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        openclawId: "oc-1",
        inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: "unauthorized" });

    const registered = await registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 5_000,
    });
    expect(registered.status).toBe(200);
    const registerBody = (await registered.json()) as {
      ok?: unknown;
      openclawId?: unknown;
      tokenType?: unknown;
      runtimeToken?: unknown;
      expiresAtMs?: unknown;
    };
    expect(registerBody).toMatchObject({
      ok: true,
      openclawId: "oc-1",
      tokenType: "Bearer",
    });
    expect(typeof registerBody.runtimeToken).toBe("string");
    expect(typeof registerBody.expiresAtMs).toBe("number");

    const jwks = await fetch(`http://127.0.0.1:${server.port}/.well-known/jwks.json`);
    expect(jwks.status).toBe(200);
    const body = (await jwks.json()) as { keys?: Array<{ kid?: string; alg?: string }> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys?.[0]).toMatchObject({
      alg: "EdDSA",
    });
    expect(typeof body.keys?.[0]?.kid).toBe("string");
  });

  test("admin pairing token endpoint requires admin auth and issues token (control-plane flow)", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_ADMIN_TOKEN: "admin-token-1",
      },
    });

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/admin/pairings/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openclawId: "oc-1",
        channel: "telegram",
        ttlSec: 60,
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: "unauthorized" });

    const issued = await createAdminPairingToken({
      port: server.port,
      adminToken: "admin-token-1",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 5_000,
      channel: "telegram",
      ttlSec: 60,
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { ok?: unknown; token?: unknown; expiresAtMs?: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAtMs).toBe("number");
  });

  test("runtime jwt auth enforces openclaw identity on outbound endpoints", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
      },
    });
    const registered = await registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
    });
    const registerBody = (await registered.json()) as {
      runtimeToken?: string;
    };
    const runtimeToken = toSafeString(registerBody.runtimeToken);
    expect(runtimeToken).toBeTruthy();

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "oc-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "hello",
        openclawId: "oc-1",
      }),
    });
    expect(valid.status).toBe(403);
    expect(await valid.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "oc-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "hello",
        openclawId: "oc-other",
      }),
    });
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "openclawId mismatch",
    });
  });

  test("outbound endpoint rejects unauthorized requests", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("hello")),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("returns 400 for invalid JSON body", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid JSON body" });
  });

  test("returns 413 when request body exceeds max size", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_MAX_BODY_BYTES: "128",
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "x".repeat(2_000),
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload too large" });
  });

  test("supports per-tenant auth from MUX_TENANTS_JSON", async () => {
    const server = await startServer({
      apiKey: "fallback-key",
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
    });

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("message without binding")),
    });
    expect(valid.status).toBe(403);
    expect(await valid.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const fallback = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fallback-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("missing to should return 400")),
    });
    expect(fallback.status).toBe(401);
    expect(await fallback.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("admin whatsapp health endpoint requires admin auth", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_ADMIN_TOKEN: "admin-secret",
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/admin/whatsapp/health`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("admin whatsapp health endpoint reports credential presence", async () => {
    const authDir = mkdtempSync(resolve(tmpdir(), "mux-wa-auth-"));
    writeFileSync(
      resolve(authDir, "creds.json"),
      JSON.stringify({ me: { id: "16693773518:1@s.whatsapp.net" } }),
      "utf8",
    );
    writeFileSync(resolve(authDir, "session-117901482786828_1.0.json"), "{}", "utf8");
    writeFileSync(resolve(authDir, "pre-key-1.json"), "{}", "utf8");

    try {
      const server = await startServer({
        extraEnv: {
          MUX_ADMIN_TOKEN: "admin-secret",
          MUX_WHATSAPP_AUTH_DIR: authDir,
        },
      });

      const response = await getAdminWhatsAppHealth({
        port: server.port,
        adminToken: "admin-secret",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        whatsapp: {
          status: string;
          inboundEnabled: boolean;
          authDir: string;
          authDirExists: boolean;
          credsPath: string;
          creds: { present: boolean };
          fileCounts: { session: number; preKey: number };
          runtime: { listenerActive: boolean };
        };
      };
      expect(body.ok).toBe(true);
      expect(body.whatsapp.inboundEnabled).toBe(true);
      expect(body.whatsapp.authDir).toBe(authDir);
      expect(body.whatsapp.authDirExists).toBe(true);
      expect(body.whatsapp.credsPath).toBe(resolve(authDir, "creds.json"));
      expect(body.whatsapp.creds.present).toBe(true);
      expect(body.whatsapp.fileCounts.session).toBe(1);
      expect(body.whatsapp.fileCounts.preKey).toBe(1);
      expect(["starting_or_idle", "listening", "listener_error"]).toContain(body.whatsapp.status);
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  test("instance register updates inbound target and forwards to latest inbound url", async () => {
    const inboundARequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const inboundBRequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];

    const inboundA = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const openclawIdHeader =
        typeof req.headers["x-openclaw-id"] === "string" ? req.headers["x-openclaw-id"] : undefined;
      inboundARequests.push({ authorization, openclawIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const inboundB = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const openclawIdHeader =
        typeof req.headers["x-openclaw-id"] === "string" ? req.headers["x-openclaw-id"] : undefined;
      inboundBRequests.push({ authorization, openclawIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    let releaseFirst = false;
    let releaseSecond = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
      let result: unknown[] = [];
      if (releaseFirst && offset <= 461) {
        result = [
          {
            update_id: 461,
            message: {
              message_id: 470,
              date: 1_700_000_000,
              text: "first target",
              from: { id: 1234 },
              chat: { id: -100557, type: "supergroup" },
            },
          },
        ];
      } else if (releaseSecond && offset <= 462) {
        result = [
          {
            update_id: 462,
            message: {
              message_id: 471,
              date: 1_700_000_001,
              text: "second target",
              from: { id: 1234 },
              chat: { id: -100557, type: "supergroup" },
            },
          },
        ];
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-ROTATE-TARGET-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100557",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const registeredA = await registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "tenant-a",
      inboundUrl: `${inboundA.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(registeredA.status).toBe(200);
    const registerBody = (await registeredA.json()) as { runtimeToken?: unknown };
    const runtimeToken = toSafeString(registerBody.runtimeToken);
    expect(runtimeToken).toBeTruthy();

    const claim = await fetch(`http://127.0.0.1:${server.port}/v1/pairings/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "tenant-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PAIR-ROTATE-TARGET-1",
        sessionKey: "agent:main:telegram:group:-100557",
      }),
    });
    expect(claim.status).toBe(200);

    releaseFirst = true;
    await waitForCondition(
      () => inboundARequests.length >= 1,
      8_000,
      "timed out waiting for first inbound target",
    );
    expectInboundJwtAuth(
      {
        authorization: inboundARequests[0]?.authorization,
        openclawIdHeader: inboundARequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    expect(inboundARequests[0]?.payload.body).toBe("first target");

    const registeredB = await registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "tenant-a",
      inboundUrl: `${inboundB.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(registeredB.status).toBe(200);

    releaseSecond = true;
    await waitForCondition(
      () => inboundBRequests.length >= 1,
      8_000,
      "timed out waiting for rotated inbound target",
    );
    expectInboundJwtAuth(
      {
        authorization: inboundBRequests[0]?.authorization,
        openclawIdHeader: inboundBRequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    expect(inboundBRequests[0]?.payload.body).toBe("second target");
    expect(inboundARequests.length).toBe(1);
  }, 20_000);

  test("supports pairing claim/list/unbind", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-1",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as {
      bindingId: string;
      channel: string;
      scope: string;
      routeKey: string;
    };
    expect(claimBody.channel).toBe("telegram");
    expect(claimBody.scope).toBe("chat");
    expect(claimBody.routeKey).toBe("telegram:default:chat:-100123");
    expect(claimBody.bindingId).toContain("bind_");
    expect((claimBody as Record<string, unknown>).sessionKey).toBe(
      "agent:main:telegram:group:-100123:topic:2",
    );

    const listedBeforeUnbind = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(listedBeforeUnbind.status).toBe(200);
    expect(await listedBeforeUnbind.json()).toEqual({
      items: [
        {
          bindingId: claimBody.bindingId,
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:-100123",
        },
      ],
    });

    const unbind = await unbindPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      bindingId: claimBody.bindingId,
    });
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });

    const listedAfterUnbind = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(listedAfterUnbind.status).toBe(200);
    expect(await listedAfterUnbind.json()).toEqual({ items: [] });
  });

  test("rejects duplicate pairing claim", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-2",
          channel: "discord",
          routeKey: "discord:default:guild:123456",
          scope: "guild",
        },
      ]),
    });

    const firstClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-2",
    });
    expect(firstClaim.status).toBe(200);

    const secondClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-b-key",
      code: "PAIR-2",
    });
    expect(secondClaim.status).toBe(409);
    expect(await secondClaim.json()).toEqual({
      ok: false,
      error: "pairing code already claimed",
    });
  });

  test("rejects cross-tenant route collisions during pairing claim", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-ROUTE-A",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
        {
          code: "PAIR-ROUTE-B",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
    });

    const first = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-ROUTE-A",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(first.status).toBe(200);

    const second = await claimPairing({
      port: server.port,
      apiKey: "tenant-b-key",
      code: "PAIR-ROUTE-B",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      ok: false,
      error: "route already bound",
    });
  });

  test("outbound resolves route from (tenant, channel, sessionKey) mapping", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-3",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-3",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        to: "this-is-ignored-on-purpose",
        text: "",
      }),
    });
    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "text or mediaUrl(s) required",
    });
  });

  test("telegram outbound requires raw envelope", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-BTN",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-BTN",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        text: "paged commands",
      }),
    });

    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "telegram outbound requires raw.telegram.method and raw.telegram.body",
    });
  });

  test("telegram outbound raw envelope preserves body and enforces route lock", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9901, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "999999",
              text: "<b>raw payload</b>",
              parse_mode: "HTML",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9901",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "<b>raw payload</b>",
      parse_mode: "HTML",
    });
  });

  test("telegram outbound raw editMessageText keeps route lock and skips thread id injection", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/editMessageText") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9902, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-EDIT",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-EDIT",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "editMessageText",
            body: {
              message_id: 321,
              text: "page 2",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9902",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_id: 321,
      text: "page 2",
    });
    expect(telegramRequests[0]?.message_thread_id).toBeUndefined();
  });

  test("telegram typing action via /send sends chat action for bound route", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendChatAction") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-TYPING",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-TYPING",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
    });
    expect(claim.status).toBe(200);

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "action",
        action: "typing",
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
      }),
    });

    expect(typing.status).toBe(200);
    expect(await typing.json()).toEqual({ ok: true });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      action: "typing",
      message_thread_id: 2,
    });
  });

  test("discord typing action via /send triggers typing on bound DM route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "6001" }));
        return;
      }
      if (method === "POST" && url === "/channels/6001/typing") {
        discordRequests.push({ method, url });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-TYPING",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-TYPING",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "action",
        action: "typing",
        channel: "discord",
        sessionKey: "dc:dm:42",
      }),
    });

    expect(typing.status).toBe(200);
    expect(await typing.json()).toEqual({ ok: true });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/users/@me/channels",
          body: { recipient_id: "42" },
        }),
        expect.objectContaining({
          method: "POST",
          url: "/channels/6001/typing",
        }),
      ]),
    );
  });

  test("whatsapp typing action via /send tries composing on bound route", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-TYPING",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-TYPING",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
    });
    expect(claim.status).toBe(200);

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "action",
        action: "typing",
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
      }),
    });

    expect(typing.status).toBe(502);
    expect(await typing.json()).toMatchObject({
      ok: false,
      error: "whatsapp typing failed",
    });
  }, 10_000);

  test("discord outbound raw envelope forwards body unchanged", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001" }));
        return;
      }
      if (method === "POST" && url === "/channels/2001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7007", channel_id: "2001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-RAW",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-RAW",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const rawBody = {
      content: "raw body",
      components: [{ type: 1, components: [{ type: 2, style: 1, label: "OK", custom_id: "ok" }] }],
    };

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        raw: {
          discord: {
            body: rawBody,
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "7007",
      channelId: "2001",
      rawPassthrough: true,
    });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/channels/2001/messages",
          body: rawBody,
        }),
      ]),
    );
  });

  test("discord outbound requires raw envelope", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-RAW-REQUIRED",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-RAW-REQUIRED",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        text: "hello without raw",
      }),
    });

    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "discord outbound requires raw.discord.body or raw.discord.send",
    });
  });

  test("sends discord outbound through guild-bound route and enforces guild lock", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      authorization?: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/channels/2001") {
        discordRequests.push({ method, url, authorization });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001", guild_id: "9001" }));
        return;
      }
      if (method === "GET" && url === "/channels/2999") {
        discordRequests.push({ method, url, authorization });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2999", guild_id: "9002" }));
        return;
      }
      if (method === "POST" && url === "/channels/2001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, authorization, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7001", channel_id: "2001" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-GUILD",
          channel: "discord",
          routeKey: "discord:default:guild:9001",
          scope: "guild",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-GUILD",
      sessionKey: "dc:guild:9001",
    });
    expect(claim.status).toBe(200);

    const allowed = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:guild:9001",
        to: "channel:2001",
        raw: {
          discord: {
            send: {
              text: "hello discord",
            },
          },
        },
      }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      ok: true,
      messageId: "7001",
      channelId: "2001",
      providerMessageIds: ["7001"],
      rawPassthrough: true,
    });

    const denied = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:guild:9001",
        to: "channel:2999",
        raw: {
          discord: {
            send: {
              text: "should fail",
            },
          },
        },
      }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      ok: false,
      error: "discord channel not allowed for this bound guild",
    });

    expect(
      discordRequests.some(
        (entry) => entry.method === "POST" && entry.url === "/channels/2001/messages",
      ),
    ).toBe(true);
    expect(
      discordRequests.every((entry) => entry.authorization === "Bot dummy-discord-token"),
    ).toBe(true);
  }, 10_000);

  test("sends discord outbound through dm-bound route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "POST" && url === "/channels/3001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "8001", channel_id: "3001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-DM",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-DM",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:4242",
        to: "user:9999",
        raw: {
          discord: {
            send: {
              text: "hello dm",
            },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      messageId: "8001",
      channelId: "3001",
      providerMessageIds: ["8001"],
      rawPassthrough: true,
    });

    const dmCreate = discordRequests.find(
      (entry) => entry.method === "POST" && entry.url === "/users/@me/channels",
    );
    expect(dmCreate?.body).toEqual({ recipient_id: "4242" });
    const sent = discordRequests.find(
      (entry) => entry.method === "POST" && entry.url === "/channels/3001/messages",
    );
    expect(sent?.body).toMatchObject({
      content: "hello dm",
    });
  });

  test("forwards inbound Telegram updates to tenant inbound endpoint", async () => {
    const inboundRequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const openclawIdHeader =
        typeof req.headers["x-openclaw-id"] === "string" ? req.headers["x-openclaw-id"] : undefined;
      inboundRequests.push({ authorization, openclawIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      telegramRequests.push(body);
      const hasOffset = typeof body.offset === "number";
      const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
      if (shouldSend) {
        hasSentUpdate = true;
      }
      const result = shouldSend
        ? [
            {
              update_id: 461,
              message: {
                message_id: 462,
                date: 1_700_000_000,
                text: "  hello from mux inbound  ",
                from: { id: 1234 },
                chat: { id: -100555, type: "supergroup" },
              },
            },
          ]
        : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-1",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    expectInboundJwtAuth(
      {
        authorization: inboundRequests[0]?.authorization,
        openclawIdHeader: inboundRequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    expect(inboundRequests[0]?.payload).toMatchObject({
      eventId: "tg:461",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100555",
      body: "  hello from mux inbound  ",
      from: "telegram:1234",
      to: "telegram:-100555",
      accountId: "default",
      chatType: "group",
      messageId: "462",
      openclawId: "tenant-a",
      channelData: {
        accountId: "default",
        messageId: "462",
        chatId: "-100555",
        topicId: null,
        routeKey: "telegram:default:chat:-100555",
        updateId: 461,
      },
    });
    expect(
      telegramRequests.some(
        (request) => typeof request.offset === "number" && Number(request.offset) >= 1,
      ),
    ).toBe(true);
  });

  test("forwards Telegram callback queries without transport rewriting", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const callbackAnswers: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 470,
                callback_query: {
                  id: "cbq-1",
                  from: { id: 1234 },
                  data: "commands_page_2:main",
                  message: {
                    message_id: 777,
                    date: 1_700_000_001,
                    text: "ℹ️ Slash commands",
                    from: { id: 9999 },
                    chat: { id: -100555, type: "supergroup" },
                  },
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.method === "POST" && req.url === "/botdummy-token/answerCallbackQuery") {
        callbackAnswers.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-CB-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-CB-TG-1",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundRequests.length > 0 && callbackAnswers.length > 0,
      5_000,
      "timed out waiting for callback forwarding",
    );

    expect(inboundRequests[0]).toMatchObject({
      eventId: "tgcb:470",
      channel: "telegram",
      event: {
        kind: "callback",
      },
      raw: {
        callbackQuery: {
          id: "cbq-1",
        },
      },
      sessionKey: "agent:main:telegram:group:-100555",
      body: "commands_page_2:main",
      from: "telegram:1234",
      to: "telegram:-100555",
      accountId: "default",
      messageId: "777",
      channelData: {
        routeKey: "telegram:default:chat:-100555",
        telegram: {
          callbackData: "commands_page_2:main",
          callbackQueryId: "cbq-1",
          callbackMessageId: "777",
        },
      },
    });
    expect(callbackAnswers[0]).toMatchObject({
      callback_query_id: "cbq-1",
    });
  });

  test("retries Telegram inbound without advancing offset when forward fails", async () => {
    const inboundAttempts: Array<Record<string, unknown>> = [];
    let failFirstForward = true;
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundAttempts.push(await readJsonBody(req));
      if (failFirstForward) {
        failFirstForward = false;
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "retry me" }));
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      telegramRequests.push(body);
      const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
      const result =
        releaseUpdates && offset <= 461
          ? [
              {
                update_id: 461,
                message: {
                  message_id: 462,
                  date: 1_700_000_000,
                  text: "retry telegram message",
                  from: { id: 1234 },
                  chat: { id: -100556, type: "supergroup" },
                },
              },
            ]
          : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-RETRY-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100556",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-RETRY-TG-1",
      sessionKey: "agent:main:telegram:group:-100556",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundAttempts.length >= 2,
      6_000,
      "timed out waiting for telegram retry forward",
    );

    expect(inboundAttempts[0]?.body).toBe("retry telegram message");
    expect(inboundAttempts[1]?.body).toBe("retry telegram message");

    const seenOffsets = telegramRequests
      .map((request) => (typeof request.offset === "number" ? Number(request.offset) : null))
      .filter((offset): offset is number => offset !== null);
    expect(seenOffsets.filter((offset) => offset === 1).length).toBeGreaterThanOrEqual(2);
    expect(seenOffsets.some((offset) => offset === 462)).toBe(true);
  }, 15_000);

  test("forwards media-only Telegram photo updates with attachment payload", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 4901,
                message: {
                  message_id: 9001,
                  date: 1_700_000_100,
                  from: { id: 1234 },
                  chat: { id: 999, type: "private" },
                  photo: [
                    { file_id: "small-photo-id", width: 16, height: 16, file_size: 100 },
                    { file_id: "best-photo-id", width: 1024, height: 1024, file_size: 4096 },
                  ],
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      if (req.method === "POST" && req.url === "/botdummy-token/getFile") {
        const body = await readJsonBody(req);
        if (body.file_id !== "best-photo-id") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: { file_path: "photos/cat.png" } }));
        return;
      }

      if (req.method === "GET" && req.url === "/file/botdummy-token/photos/cat.png") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(pngBuffer.byteLength),
        });
        res.end(pngBuffer);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-MEDIA-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:999",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-MEDIA-1",
      sessionKey: "agent:main:telegram:direct:999",
    });
    expect(claim.status).toBe(200);

    releaseUpdates = true;
    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for media-only inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0];
    expect(payload.channel).toBe("telegram");
    expect(payload.sessionKey).toBe("agent:main:telegram:direct:999");
    expect(payload.body).toBe("");
    expect(payload.messageId).toBe("9001");

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe("image/jpeg");
    expect(typeof attachments[0]?.url).toBe("string");
    expect(String(attachments[0]?.url)).toContain("/v1/mux/files/telegram?fileId=");

    const channelData =
      payload.channelData && typeof payload.channelData === "object"
        ? (payload.channelData as Record<string, unknown>)
        : {};
    const telegramData =
      channelData.telegram && typeof channelData.telegram === "object"
        ? (channelData.telegram as Record<string, unknown>)
        : {};
    const media = Array.isArray(telegramData.media)
      ? (telegramData.media as Array<Record<string, unknown>>)
      : [];
    expect(media).toHaveLength(1);
    expect(media[0]?.kind).toBe("photo");
    expect(media[0]?.fileId).toBe("best-photo-id");
    expect(channelData.telegram).toBeDefined();
    const rawTelegram =
      channelData.telegram && typeof channelData.telegram === "object"
        ? (channelData.telegram as Record<string, unknown>)
        : {};
    const rawMessage =
      rawTelegram.rawMessage && typeof rawTelegram.rawMessage === "object"
        ? (rawTelegram.rawMessage as Record<string, unknown>)
        : {};
    expect(rawMessage.message_id).toBe(9001);
    const rawUpdate =
      rawTelegram.rawUpdate && typeof rawTelegram.rawUpdate === "object"
        ? (rawTelegram.rawUpdate as Record<string, unknown>)
        : {};
    expect(rawUpdate.update_id).toBe(4901);
  });

  test("forwards inbound Discord DM messages with raw payload and media attachment", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let deliveredMessage = false;

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        expect(body).toEqual({ recipient_id: "4242" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "GET" && url.startsWith("/channels/3001/messages")) {
        const parsed = new URL(`http://127.0.0.1${url}`);
        const after = parsed.searchParams.get("after");
        if (!after && !deliveredMessage) {
          deliveredMessage = true;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify([
              {
                id: "9001",
                channel_id: "3001",
                content: "  hello from discord inbound  ",
                timestamp: "2026-02-07T03:00:00.000Z",
                author: { id: "4242", bot: false },
                attachments: [
                  {
                    id: "att-1",
                    filename: "cat.png",
                    content_type: "image/png",
                    size: pngBuffer.byteLength,
                    url: `${discordApi.url}/files/cat.png`,
                  },
                ],
              },
            ]),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify([]));
        return;
      }
      if (method === "GET" && url === "/files/cat.png") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(pngBuffer.byteLength),
        });
        res.end(pngBuffer);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-DC-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for discord inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0];
    expect(payload).toMatchObject({
      channel: "discord",
      sessionKey: "dc:dm:4242",
      body: "  hello from discord inbound  ",
      from: "discord:4242",
      to: "channel:3001",
      accountId: "default",
      chatType: "direct",
      messageId: "9001",
    });

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe("image/png");
    expect(typeof attachments[0]?.url).toBe("string");
    expect(String(attachments[0]?.url)).toContain("/files/cat.png");

    const channelData =
      payload.channelData && typeof payload.channelData === "object"
        ? (payload.channelData as Record<string, unknown>)
        : {};
    expect(channelData.routeKey).toBe("discord:default:dm:user:4242");
    const discordData =
      channelData.discord && typeof channelData.discord === "object"
        ? (channelData.discord as Record<string, unknown>)
        : {};
    const rawMessage =
      discordData.rawMessage && typeof discordData.rawMessage === "object"
        ? (discordData.rawMessage as Record<string, unknown>)
        : {};
    expect(rawMessage.id).toBe("9001");
    expect(rawMessage.content).toBe("  hello from discord inbound  ");
  });

  test("retries Discord failed message without replaying already-acked earlier message", async () => {
    const inboundAttempts: Array<Record<string, unknown>> = [];
    let msgTwoFailures = 0;
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      inboundAttempts.push(payload);
      if (payload.body === "msg-two" && msgTwoFailures === 0) {
        msgTwoFailures += 1;
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "retry me" }));
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await readJsonBody(req);
        expect(body).toEqual({ recipient_id: "4242" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/channels/3001/messages") {
        const after = requestUrl.searchParams.get("after");
        const result =
          after === null
            ? [
                {
                  id: "1001",
                  channel_id: "3001",
                  content: "msg-one",
                  timestamp: "2026-02-07T03:00:00.000Z",
                  author: { id: "4242", bot: false },
                  attachments: [],
                },
                {
                  id: "1002",
                  channel_id: "3001",
                  content: "msg-two",
                  timestamp: "2026-02-07T03:00:01.000Z",
                  author: { id: "4242", bot: false },
                  attachments: [],
                },
              ]
            : after === "1001"
              ? [
                  {
                    id: "1002",
                    channel_id: "3001",
                    content: "msg-two",
                    timestamp: "2026-02-07T03:00:01.000Z",
                    author: { id: "4242", bot: false },
                    attachments: [],
                  },
                ]
              : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-DC-RETRY-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-RETRY-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await waitForCondition(
      () =>
        inboundAttempts.filter((payload) => payload.body === "msg-one").length >= 1 &&
        inboundAttempts.filter((payload) => payload.body === "msg-two").length >= 2,
      6_000,
      "timed out waiting for discord retry behavior",
    );

    const msgOneCount = inboundAttempts.filter((payload) => payload.body === "msg-one").length;
    const msgTwoCount = inboundAttempts.filter((payload) => payload.body === "msg-two").length;
    expect(msgOneCount).toBe(1);
    expect(msgTwoCount).toBe(2);
  }, 15_000);

  test("pairs from dashboard token sent via /start and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
        const result = deliverable.map((entry) => entry.entry);
        if (deliverable.length > 0) {
          const maxDelivered = deliverable[deliverable.length - 1]?.updateId ?? 0;
          for (let i = pendingUpdates.length - 1; i >= 0; i -= 1) {
            const updateId = Number(pendingUpdates[i]?.update_id ?? 0);
            if (Number.isFinite(updateId) && updateId <= maxDelivered) {
              pendingUpdates.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url === "/botdummy-token/sendMessage") {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 901,
              chat: { id: -100777, type: "supergroup", title: "pairing-test" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        MUX_TELEGRAM_BOT_USERNAME: "dummy_bot",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100777:topic:2",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
      deepLink?: string | null;
      startCommand?: string | null;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);
    expect(tokenBody.deepLink).toContain(tokenBody.token);
    expect(tokenBody.startCommand).toContain(tokenBody.token);

    pendingUpdates.push({
      update_id: 3001,
      message: {
        message_id: 8001,
        text: `/start ${tokenBody.token}`,
        date: 1_700_000_000,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup" },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3002,
      message: {
        message_id: 8002,
        text: "/help",
        date: 1_700_000_001,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup" },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3003,
      message: {
        message_id: 8003,
        text: `/start ${tokenBody.token}`,
        date: 1_700_000_002,
        from: { id: 1234 },
        chat: { id: 999, type: "private" },
      },
    });
    pendingUpdates.push({
      update_id: 3004,
      message: {
        message_id: 8004,
        text: "hello before pairing",
        date: 1_700_000_003,
        from: { id: 1234 },
        chat: { id: 999, type: "private" },
      },
    });

    await waitForCondition(
      () => inboundRequests.length >= 1 && sentMessages.length >= 3,
      5_000,
      "timed out waiting for post-pair inbound forward and notices",
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100777:topic:2",
      body: "/help",
      messageId: "8002",
      threadId: 2,
      channelData: {
        chatId: "-100777",
        topicId: 2,
        routeKey: "telegram:default:chat:-100777:topic:2",
      },
    });

    expect(sentMessages.some((message) => toSafeString(message.text).includes("Paired"))).toBe(
      true,
    );
    expect(
      sentMessages.some(
        (message) =>
          toSafeString(message.chat_id) === "999" &&
          toSafeString(message.text).includes("Invalid token"),
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (message) =>
          toSafeString(message.chat_id) === "999" &&
          toSafeString(message.text).includes("This chat is not paired"),
      ),
    ).toBe(true);

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "topic",
          routeKey: "telegram:default:chat:-100777:topic:2",
        },
      ],
    });
  });

  test("pairs telegram DM threads once and isolates sessions per thread", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
        const result = deliverable.map((entry) => entry.entry);
        if (deliverable.length > 0) {
          const maxDelivered = deliverable[deliverable.length - 1]?.updateId ?? 0;
          for (let i = pendingUpdates.length - 1; i >= 0; i -= 1) {
            const updateId = Number(pendingUpdates[i]?.update_id ?? 0);
            if (Number.isFinite(updateId) && updateId <= maxDelivered) {
              pendingUpdates.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url === "/botdummy-token/sendMessage") {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 902,
              chat: { id: 999, type: "private" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "telegram",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);

    pendingUpdates.push(
      {
        update_id: 4101,
        message: {
          message_id: 9101,
          text: `/start ${tokenBody.token}`,
          date: 1_700_000_100,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 2,
        },
      },
      {
        update_id: 4102,
        message: {
          message_id: 9102,
          text: "hello thread two",
          date: 1_700_000_101,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 2,
        },
      },
      {
        update_id: 4103,
        message: {
          message_id: 9103,
          text: "hello thread three",
          date: 1_700_000_102,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 3,
        },
      },
    );

    await waitForCondition(
      () => inboundRequests.length >= 2,
      5_000,
      "timed out waiting for thread-scoped inbound forwards",
    );

    expect(inboundRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:direct:999:thread:2",
          body: "hello thread two",
          threadId: 2,
          channelData: expect.objectContaining({
            routeKey: "telegram:default:chat:999:topic:2",
          }),
        }),
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:direct:999:thread:3",
          body: "hello thread three",
          threadId: 3,
          channelData: expect.objectContaining({
            routeKey: "telegram:default:chat:999:topic:3",
          }),
        }),
      ]),
    );

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:999",
        },
      ],
    });

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:999:thread:3",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "reply thread 3",
            },
          },
        },
      }),
    });
    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "902",
      rawPassthrough: true,
    });

    const threadReply = sentMessages.find(
      (message) => toSafeString(message.text) === "reply thread 3",
    );
    expect(threadReply).toBeDefined();
    expect(toSafeString(threadReply?.chat_id)).toBe("999");
    expect(threadReply?.message_thread_id).toBe(3);
  });

  test("maps forum general topic to thread 1 and omits message_thread_id on sendMessage", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      if (!req.url) {
        res.writeHead(404);
        res.end();
        return;
      }
      telegramRequests.push({ path: req.url, body });
      if (req.url === "/botdummy-token/getUpdates") {
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 7001,
                message: {
                  message_id: 7002,
                  date: 1_700_000_300,
                  text: "hello from forum general",
                  from: { id: 1234 },
                  chat: { id: -100909, type: "supergroup", is_forum: true },
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (
        req.url === "/botdummy-token/sendMessage" ||
        req.url === "/botdummy-token/sendChatAction"
      ) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9911, chat: { id: -100909 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-FORUM-GEN-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100909",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-FORUM-GEN-1",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for forum general inbound forward",
    );

    expect(inboundRequests[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100909:topic:1",
      threadId: 1,
      channelData: {
        chatId: "-100909",
        topicId: 1,
        routeKey: "telegram:default:chat:-100909:topic:1",
      },
    });

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100909:topic:1",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "forum general reply",
              message_thread_id: 1,
            },
          },
        },
      }),
    });
    expect(outbound.status).toBe(200);

    const sendMessageRequest = telegramRequests.find(
      (request) =>
        request.path === "/botdummy-token/sendMessage" &&
        toSafeString(request.body.text) === "forum general reply",
    );
    expect(sendMessageRequest).toBeDefined();
    expect(toSafeString(sendMessageRequest?.body.chat_id)).toBe("-100909");
    expect(sendMessageRequest?.body.message_thread_id).toBeUndefined();

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100909:topic:1",
        op: "action",
        action: "typing",
      }),
    });
    expect(typing.status).toBe(200);

    const typingRequest = telegramRequests.find(
      (request) => request.path === "/botdummy-token/sendChatAction",
    );
    expect(typingRequest).toBeDefined();
    expect(toSafeString(typingRequest?.body.chat_id)).toBe("-100909");
    expect(toSafeString(typingRequest?.body.action)).toBe("typing");
    expect(typingRequest?.body.message_thread_id).toBe(1);
  });

  test("pairs from dashboard token sent in discord DM and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dmChannelId = "777001";
    const dmUserId = "4242";
    const pairingNotices: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: WebSocket | null;
      identified: boolean;
      dispatched: boolean;
      pairingToken: string | null;
    } = {
      socket: null,
      identified: false,
      dispatched: false,
      pairingToken: null,
    };

    const dispatchGatewayMessages = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.pairingToken ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      const socket = gatewayState.socket;
      const author = {
        id: dmUserId,
        bot: false,
        username: "tester",
      };
      const buildMessage = (id: string, content: string, timestamp: string) => ({
        id,
        channel_id: dmChannelId,
        type: 0,
        content,
        author,
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: buildMessage("1001", "hello before pairing", "2026-01-01T00:00:01.000Z"),
          }),
        );
      }, 40);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 3,
            d: buildMessage("1002", "mpt_abcdefghijklmnopqrstuvwxyz", "2026-01-01T00:00:02.000Z"),
          }),
        );
      }, 120);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 4,
            d: buildMessage("1003", gatewayState.pairingToken ?? "", "2026-01-01T00:00:03.000Z"),
          }),
        );
      }, 200);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 5,
            d: buildMessage("1004", "hello after pair", "2026-01-01T00:00:04.000Z"),
          }),
        );
      }, 280);
    };

    const gateway = await startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-dm-test" },
          }),
        );
        dispatchGatewayMessages();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        pairingNotices.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + pairingNotices.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
      deepLink?: string | null;
      startCommand?: string | null;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);
    expect(tokenBody.deepLink ?? null).toBeNull();
    expect(tokenBody.startCommand ?? null).toBeNull();

    gatewayState.pairingToken = tokenBody.token;
    dispatchGatewayMessages();

    await waitForCondition(
      () => inboundRequests.length >= 1 && pairingNotices.length >= 3,
      12_000,
      "timed out waiting for discord post-pair inbound forward and notices",
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "discord",
      sessionKey: "agent:main:discord:direct:4242",
      body: "hello after pair",
      messageId: "1004",
      from: "discord:4242",
      to: "channel:777001",
      chatType: "direct",
      channelData: {
        channelId: "777001",
        routeKey: "discord:default:dm:user:4242",
      },
    });

    expect(
      pairingNotices.some((message) =>
        toSafeString(message.content).includes("This chat is not paired"),
      ),
    ).toBe(true);
    expect(
      pairingNotices.some((message) => toSafeString(message.content).includes("Invalid token")),
    ).toBe(true);
    expect(pairingNotices.some((message) => toSafeString(message.content).includes("Paired"))).toBe(
      true,
    );

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "dm",
          routeKey: "discord:default:dm:user:4242",
        },
      ],
    });
  }, 15_000);

  test("maps discord guild threads to thread-scoped sessions from route-less pairing", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const guildId = "9001";
    const guildChannelId = "12345";
    const threadAId = "777101";
    const threadBId = "777102";
    const guildUserId = "4242";
    const pairingNotices: Array<Record<string, unknown>> = [];

    const gatewayState: {
      socket: WebSocket | null;
      identified: boolean;
      dispatched: boolean;
      pairingToken: string | null;
    } = {
      socket: null,
      identified: false,
      dispatched: false,
      pairingToken: null,
    };

    const dispatchGatewayMessages = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.pairingToken ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      const socket = gatewayState.socket;
      const author = {
        id: guildUserId,
        bot: false,
        username: "guild-user",
      };
      const buildMessage = (
        id: string,
        channelId: string,
        content: string,
        isoTimestamp: string,
      ) => ({
        id,
        channel_id: channelId,
        guild_id: guildId,
        type: 0,
        content,
        author,
        thread: {
          id: channelId,
          parent_id: guildChannelId,
        },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: isoTimestamp,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: buildMessage(
              "2001",
              threadAId,
              gatewayState.pairingToken ?? "",
              "2026-01-01T00:01:01.000Z",
            ),
          }),
        );
      }, 40);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 3,
            d: buildMessage("2002", threadAId, "hello guild thread a", "2026-01-01T00:01:02.000Z"),
          }),
        );
      }, 180);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 4,
            d: buildMessage("2003", threadBId, "hello guild thread b", "2026-01-01T00:01:03.000Z"),
          }),
        );
      }, 320);
    };

    const gateway = await startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-test" },
          }),
        );
        dispatchGatewayMessages();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (channelMessagesMatch) {
        if (method === "GET") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify([]));
          return;
        }
        if (method === "POST") {
          pairingNotices.push(await readJsonBody(req));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: String(10_000 + pairingNotices.length),
              channel_id: channelMessagesMatch[1],
            }),
          );
          return;
        }
      }

      const channelMatch = requestUrl.pathname.match(/^\/channels\/(\d+)$/);
      if (method === "GET" && channelMatch) {
        const channelId = channelMatch[1];
        if (channelId === threadAId || channelId === threadBId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              parent_id: guildChannelId,
              type: 11,
            }),
          );
          return;
        }
        if (channelId === guildChannelId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              type: 0,
            }),
          );
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_DISCORD_GATEWAY_DM_ENABLED: "false",
        MUX_DISCORD_GATEWAY_GUILD_ENABLED: "true",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: `agent:main:discord:channel:${guildChannelId}`,
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
    };
    gatewayState.pairingToken = tokenBody.token;
    dispatchGatewayMessages();

    await waitForCondition(
      () => inboundRequests.length >= 2,
      20_000,
      "timed out waiting for discord guild thread inbound forwards",
    );

    expect(inboundRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadAId}`,
          body: "hello guild thread a",
          threadId: threadAId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadAId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadAId}`,
          }),
        }),
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadBId}`,
          body: "hello guild thread b",
          threadId: threadBId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadBId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadBId}`,
          }),
        }),
      ]),
    );

    expect(pairingNotices.some((notice) => toSafeString(notice.content).includes("Paired"))).toBe(
      true,
    );

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "channel",
          routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}`,
        },
      ],
    });
  }, 20_000);

  test("telegram bot control commands support help, status, unpair, and switch", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
        const result = deliverable.map((entry) => entry.entry);
        if (deliverable.length > 0) {
          const maxDelivered = deliverable[deliverable.length - 1]?.updateId ?? 0;
          for (let i = pendingUpdates.length - 1; i >= 0; i -= 1) {
            const updateId = Number(pendingUpdates[i]?.update_id ?? 0);
            if (Number.isFinite(updateId) && updateId <= maxDelivered) {
              pendingUpdates.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url === "/botdummy-token/sendMessage") {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1101,
              chat: { id: -100888, type: "supergroup", title: "mux-bot-control" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
        {
          id: "tenant-b",
          name: "Tenant B",
          apiKey: "tenant-b-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-BOT-CTRL",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100888",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const initialClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-BOT-CTRL",
      sessionKey: "agent:main:telegram:group:-100888",
    });
    expect(initialClaim.status).toBe(200);

    const switchTokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100888:switch",
      ttlSec: 120,
    });
    expect(switchTokenResponse.status).toBe(200);
    const switchTokenBody = (await switchTokenResponse.json()) as { token: string };
    expect(switchTokenBody.token.startsWith("mpt_")).toBe(true);

    pendingUpdates.push(
      {
        update_id: 4101,
        message: {
          message_id: 9101,
          text: "/bot_help",
          date: 1_700_000_100,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4102,
        message: {
          message_id: 9102,
          text: "/bot_status",
          date: 1_700_000_101,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4103,
        message: {
          message_id: 9103,
          text: "/bot_unpair",
          date: 1_700_000_102,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4104,
        message: {
          message_id: 9104,
          text: `/bot_switch ${switchTokenBody.token}`,
          date: 1_700_000_103,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4105,
        message: {
          message_id: 9105,
          text: "/help",
          date: 1_700_000_104,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
    );

    await waitForCondition(
      () => inboundRequests.length >= 1 && sentMessages.length >= 4,
      7_000,
      "timed out waiting for telegram bot control flow",
    );

    expect(
      sentMessages.some((msg) => toSafeString(msg.text).includes("Bot control commands")),
    ).toBe(true);
    expect(sentMessages.some((msg) => toSafeString(msg.text).includes("Bot status"))).toBe(true);
    expect(sentMessages.some((msg) => toSafeString(msg.text).includes("Paired: yes"))).toBe(true);
    expect(
      sentMessages.some((msg) => toSafeString(msg.text).includes("Unpaired successfully")),
    ).toBe(true);
    expect(sentMessages.some((msg) => toSafeString(msg.text).includes("Paired successfully"))).toBe(
      true,
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100888:switch",
      body: "/help",
      channelData: {
        routeKey: "telegram:default:chat:-100888",
      },
    });

    const pairingsA = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairingsA.status).toBe(200);
    expect(await pairingsA.json()).toEqual({ items: [] });

    const pairingsB = await listPairings({ port: server.port, apiKey: "tenant-b-key" });
    expect(pairingsB.status).toBe(200);
    expect(await pairingsB.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:-100888",
        },
      ],
    });
  }, 20_000);

  test("discord bot control commands support status, unpair, and switch on an active route", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dmChannelId = "778001";
    const dmUserId = "4242";
    const sentMessages: Array<Record<string, unknown>> = [];
    const pendingMessages: Array<Record<string, unknown>> = [];
    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await readJsonBody(req);
        const recipientId = toSafeString(body.recipient_id);
        if (recipientId === dmUserId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: dmChannelId }));
          return;
        }
      }

      if (method === "GET" && requestUrl.pathname === `/channels/${dmChannelId}/messages`) {
        const after = requestUrl.searchParams.get("after");
        const afterNum = after && /^\d+$/.test(after) ? BigInt(after) : null;
        const deliverable = pendingMessages
          .filter((message) => {
            const id = toSafeString(message.id);
            if (!/^\d+$/.test(id)) {
              return false;
            }
            return afterNum === null ? true : BigInt(id) > afterNum;
          })
          .toSorted((a, b) => Number(toSafeString(a.id, "0")) - Number(toSafeString(b.id, "0")));
        if (deliverable.length > 0) {
          const maxDelivered = BigInt(toSafeString(deliverable[deliverable.length - 1]?.id, "0"));
          for (let i = pendingMessages.length - 1; i >= 0; i -= 1) {
            const id = toSafeString(pendingMessages[i]?.id, "0");
            if (/^\d+$/.test(id) && BigInt(id) <= maxDelivered) {
              pendingMessages.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(deliverable));
        return;
      }

      if (method === "POST" && requestUrl.pathname === `/channels/${dmChannelId}/messages`) {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9500 + sentMessages.length),
            channel_id: dmChannelId,
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
        {
          id: "tenant-b",
          name: "Tenant B",
          apiKey: "tenant-b-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DC-BOT-CTRL",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const initialClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DC-BOT-CTRL",
      sessionKey: "dc:dm:4242",
    });
    expect(initialClaim.status).toBe(200);

    const switchTokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      channel: "discord",
      sessionKey: "dc:dm:4242:switch",
      ttlSec: 120,
    });
    expect(switchTokenResponse.status).toBe(200);
    const switchTokenBody = (await switchTokenResponse.json()) as { token: string };
    expect(switchTokenBody.token.startsWith("mpt_")).toBe(true);

    pendingMessages.push(
      {
        id: "1201",
        channel_id: dmChannelId,
        type: 0,
        content: "!bot_status",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:01.000Z",
      },
      {
        id: "1202",
        channel_id: dmChannelId,
        type: 0,
        content: "/bot_unpair",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:02.000Z",
      },
      {
        id: "1203",
        channel_id: dmChannelId,
        type: 0,
        content: "!bot_status",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:03.000Z",
      },
      {
        id: "1204",
        channel_id: dmChannelId,
        type: 0,
        content: `!bot_switch ${switchTokenBody.token}`,
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:04.000Z",
      },
    );

    await waitForCondition(
      () => sentMessages.some((msg) => toSafeString(msg.content).includes("Paired successfully")),
      12_000,
      "timed out waiting for discord bot switch success",
    );

    pendingMessages.push({
      id: "1205",
      channel_id: dmChannelId,
      type: 0,
      content: "/help",
      author: { id: dmUserId, bot: false, username: "tester" },
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:10:05.000Z",
    });

    await waitForCondition(
      () => inboundRequests.length >= 1,
      12_000,
      "timed out waiting for discord /help forward after switch",
    );

    expect(sentMessages.some((msg) => toSafeString(msg.content).includes("Bot status"))).toBe(true);
    expect(sentMessages.some((msg) => toSafeString(msg.content).includes("Paired: yes"))).toBe(
      true,
    );
    expect(sentMessages.some((msg) => toSafeString(msg.content).includes("Paired: no"))).toBe(true);
    expect(
      sentMessages.some((msg) => toSafeString(msg.content).includes("Unpaired successfully")),
    ).toBe(true);
    expect(
      sentMessages.some((msg) => toSafeString(msg.content).includes("Paired successfully")),
    ).toBe(true);

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "discord",
      sessionKey: "dc:dm:4242:switch",
      body: "/help",
      channelData: {
        routeKey: "discord:default:dm:user:4242",
      },
    });

    const pairingsA = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairingsA.status).toBe(200);
    expect(await pairingsA.json()).toEqual({ items: [] });

    const pairingsB = await listPairings({ port: server.port, apiKey: "tenant-b-key" });
    expect(pairingsB.status).toBe(200);
    expect(await pairingsB.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "dm",
          routeKey: "discord:default:dm:user:4242",
        },
      ],
    });
  }, 20_000);

  test("acks discord invalid pairing token message to avoid replay spam", async () => {
    const dmChannelId = "997001";
    const dmUserId = "9090";
    const sentMessages: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: WebSocket | null;
      identified: boolean;
      allowDispatch: boolean;
      dispatched: boolean;
    } = {
      socket: null,
      identified: false,
      allowDispatch: false,
      dispatched: false,
    };

    const dispatchInvalidTokenMessage = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.allowDispatch ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      gatewayState.socket.send(
        JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 2,
          d: {
            id: "1001",
            channel_id: dmChannelId,
            type: 0,
            content: "mpt_invalid_token_value_abcdefghijklmnopqrstuvwxyz",
            author: {
              id: dmUserId,
              bot: false,
              username: "tester",
            },
            attachments: [],
            mentions: [],
            mention_roles: [],
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        }),
      );
    };

    const gateway = await startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-invalid-token" },
          }),
        );
        dispatchInvalidTokenMessage();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + sentMessages.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: "dc:dm:9090",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    await waitForCondition(
      () => gatewayState.identified,
      5_000,
      "timed out waiting for discord gateway identify",
    );
    gatewayState.allowDispatch = true;
    dispatchInvalidTokenMessage();

    await waitForCondition(
      () => sentMessages.some((message) => toSafeString(message.content).includes("Invalid token")),
      8_000,
      "timed out waiting for discord invalid-token notice",
    );
    const noticeCountAtFirstAck = sentMessages.length;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    expect(sentMessages.length).toBe(noticeCountAtFirstAck);
  }, 15_000);

  test("allows multiple discord pairing tokens without route pre-locking", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
    });

    const firstToken = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: "dc:dm:777777",
      ttlSec: 120,
    });
    expect(firstToken.status).toBe(200);
    expect(await firstToken.json()).toMatchObject({
      ok: true,
      channel: "discord",
      token: expect.stringMatching(/^mpt_/),
    });

    const secondToken = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      channel: "discord",
      sessionKey: "dc:dm:777777",
      ttlSec: 120,
    });
    expect(secondToken.status).toBe(200);
    expect(await secondToken.json()).toMatchObject({
      ok: true,
      channel: "discord",
    });
  }, 15_000);

  test("does not consume discord token when first claim attempt is invalid", async () => {
    const dmChannelId = "997001";
    const dmUserId = "9090";
    const sentMessages: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: WebSocket | null;
      identified: boolean;
    } = {
      socket: null,
      identified: false,
    };

    const dispatchMessage = (id: string, content: string, timestamp: string) => {
      if (!gatewayState.socket || !gatewayState.identified) {
        return;
      }
      gatewayState.socket.send(
        JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: Number(id),
          d: {
            id,
            channel_id: dmChannelId,
            type: 0,
            content,
            author: {
              id: dmUserId,
              bot: false,
              username: "tester",
            },
            attachments: [],
            mentions: [],
            mention_roles: [],
            timestamp,
          },
        }),
      );
    };

    const gateway = await startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-claim-retry" },
          }),
        );
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + sentMessages.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
      },
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: "dc:dm:9090",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as { token: string };
    await waitForCondition(
      () => gatewayState.identified,
      5_000,
      "timed out waiting for discord gateway identify before token claim",
    );

    const dbPath = resolve(server.tempDir, "mux-server.sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE pairing_tokens SET channel = 'telegram' WHERE tenant_id = ? AND channel = 'discord' AND consumed_at_ms IS NULL",
    ).run("tenant-a");
    db.close();

    dispatchMessage("1001", tokenBody.token, "2026-01-01T00:00:01.000Z");

    await waitForCondition(
      () => sentMessages.some((message) => toSafeString(message.content).includes("Invalid token")),
      6_000,
      "timed out waiting for failed discord token claim",
    );

    const dbRestore = new DatabaseSync(dbPath);
    dbRestore
      .prepare(
        "UPDATE pairing_tokens SET channel = 'discord' WHERE tenant_id = ? AND channel = 'telegram' AND consumed_at_ms IS NULL",
      )
      .run("tenant-a");
    dbRestore.close();

    dispatchMessage("1002", tokenBody.token, "2026-01-01T00:00:02.000Z");

    await waitForCondition(
      () => sentMessages.some((message) => toSafeString(message.content).includes("Paired")),
      6_000,
      "timed out waiting for successful discord token claim after failure",
    );
  }, 20_000);

  test("issues whatsapp pairing token without deep link or start command", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const tokenResponse = await createAdminPairingToken({
      port: server.port,
      adminToken: DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "whatsapp",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toMatchObject({
      ok: true,
      channel: "whatsapp",
      token: expect.stringMatching(/^mpt_/),
      deepLink: null,
      startCommand: null,
    });
  });

  test("whatsapp outbound accepts legacy text envelope", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-RAW-REQUIRED",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-RAW-REQUIRED",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
        text: "hello without raw",
      }),
    });
    expect(outbound.status).toBe(502);
    expect(await outbound.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });

  test("whatsapp outbound returns 502 when no active listener is available", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-1",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-1",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
    });
    expect(claim.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
        raw: {
          whatsapp: {
            send: {
              text: "hello wa",
            },
          },
        },
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });

  test("idempotency replays same payload and rejects mismatched payload", async () => {
    const server = await startServer();
    const first = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "route not bound check",
    });
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const replay = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "route not bound check",
    });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "different payload",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });
  });

  test("idempotency survives restart with SQLite", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "mux-server-restart-"));
    const dbPath = resolve(tempDir, "mux-server.sqlite");

    const firstServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const first = await sendWithIdempotency({
      port: firstServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "route not bound before restart",
    });
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    await stopServer(firstServer);
    removeRunningServer(firstServer);

    const secondServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const replay = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "route not bound before restart",
    });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "different payload after restart",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });

    await stopServer(secondServer);
    removeRunningServer(secondServer);
    rmSync(tempDir, { recursive: true, force: true });
  }, 20_000);
});
