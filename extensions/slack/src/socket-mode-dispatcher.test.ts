import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { resolveSlackMonitorDispatchers } from "./client-options.js";

// Public test-only material. Valid through 2126; SANs cover the fixture host and loopback.
const PROXY_FIXTURE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUYQmcXrXXGwb7iM9LvhwniX+tYY8wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQZmlsZXMucHJveHkudGVzdDAgFw0yNjA4MjgwMDM2NDlaGA8y
MTI2MDgwNDAwMzY0OVowGzEZMBcGA1UEAwwQZmlsZXMucHJveHkudGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABLZqBKM03chE4ezcYB0l3E7SyeaqBbZF624k
p5Fuf97TzZNHxLHn/I9wBzICnqEQfX2De0X8JPv9AaIab3oFmF6jdjB0MB0GA1Ud
DgQWBBRQmY8ZLuaAJjUU4JiehaVg+f+KoDAfBgNVHSMEGDAWgBRQmY8ZLuaAJjUU
4JiehaVg+f+KoDAPBgNVHRMBAf8EBTADAQH/MCEGA1UdEQQaMBiCEGZpbGVzLnBy
b3h5LnRlc3SHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIhAL9IXiyh36hCytGAMVBn
6/BdZ4GB+I9sJxihRSip4G+wAiAsSHjAkfx+Yn8VgTrjXWOF9dGhzxnD/kWC4BMK
j3DhDg==
-----END CERTIFICATE-----`;
const PRIVATE_KEY_LABEL = "PRIVATE KEY";
const PROXY_FIXTURE_KEY = [
  `-----BEGIN ${PRIVATE_KEY_LABEL}-----`, // pragma: allowlist secret
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfspG17/CYh4YJnUX",
  "Wg6IAGuJtpZH2Kw8B0TE9aBKz26hRANCAAS2agSjNN3IROHs3GAdJdxO0snmqgW2",
  "RetuJKeRbn/e082TR8Sx5/yPcAcyAp6hEH19g3tF/CT7/QGiGm96BZhe",
  `-----END ${PRIVATE_KEY_LABEL}-----`,
].join("\n");

const PROXY_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const originalEnv = { ...process.env };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const closers: Array<() => Promise<void> | void> = [];
const execFileAsync = promisify(execFile);

// The undici copy @slack/socket-mode itself loads (bare import, as the SDK does).
type SocketModeUndici = typeof import("undici");
function loadSocketModeUndici(): SocketModeUndici {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromBolt = createRequire(requireFromTest.resolve("@slack/bolt/package.json"));
  const requireFromSocketMode = createRequire(
    requireFromBolt.resolve("@slack/socket-mode/package.json"),
  );
  return requireFromSocketMode("undici") as SocketModeUndici;
}

function clearProxyEnv() {
  for (const key of PROXY_KEYS) {
    delete process.env[key];
  }
}

function restoreProxyEnv() {
  for (const key of PROXY_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

async function startConnectProxy(options: { tls?: boolean } = {}): Promise<{
  url: string;
  targets: string[];
  secureConnections: () => number;
}> {
  const targets: string[] = [];
  let secureConnections = 0;
  const reject = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(405);
    res.end();
  };
  const server = options.tls
    ? https.createServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE }, reject)
    : http.createServer(reject);
  if (options.tls) {
    server.on("secureConnection", () => {
      secureConnections += 1;
    });
  }
  server.on("connect", (req, client, head) => {
    targets.push(String(req.url));
    const [host, port] = String(req.url).split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const scheme = options.tls ? "https" : "http";
  return {
    url: `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    targets,
    secureConnections: () => secureConnections,
  };
}

async function startEchoWebSocketServer(options: { tls?: boolean } = {}): Promise<string> {
  const server = options.tls
    ? https.createServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE })
    : undefined;
  const wss = server
    ? new WebSocketServer({ server })
    : new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket) =>
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary })),
  );
  if (server) {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
  } else {
    await new Promise<void>((resolve) => {
      wss.once("listening", resolve);
    });
  }
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          if (!server) {
            resolve();
            return;
          }
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }),
  );
  const address = (server ?? wss).address() as AddressInfo;
  return `${options.tls ? "wss" : "ws"}://127.0.0.1:${address.port}`;
}

async function echoThroughTrustedChildProcess(options: {
  proxyUrl: string;
  targetCaFile: string;
  targetUrl: string;
}): Promise<{ ok: true; echoed: string }> {
  const script = `
    import { createRequire } from "node:module";
    import { resolveSlackMonitorDispatchers } from "./extensions/slack/src/client-options.ts";
    const requireFromTest = createRequire(
      new URL("./extensions/slack/src/client-options.ts", import.meta.url),
    );
    const requireFromBolt = createRequire(requireFromTest.resolve("@slack/bolt/package.json"));
    const requireFromSocketMode = createRequire(requireFromBolt.resolve("@slack/socket-mode/package.json"));
    const { WebSocket } = requireFromSocketMode("undici");
    const dispatchers = resolveSlackMonitorDispatchers("socket");
    const dispatcher = dispatchers.socketMode;
    const result = await new Promise((resolve, reject) => {
      const ws = new WebSocket(process.env.TEST_WEBSOCKET_URL, { dispatcher });
      const timer = setTimeout(() => reject(new Error("WebSocket echo timed out")), 5_000);
      ws.addEventListener("open", () => ws.send("hello"));
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve({ ok: true, echoed: String(event.data) });
      });
      ws.addEventListener("error", reject);
    });
    await dispatchers.close();
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HTTPS_PROXY: options.proxyUrl,
        NODE_EXTRA_CA_CERTS: options.targetCaFile,
        TEST_WEBSOCKET_URL: options.targetUrl,
      },
      timeout: 10_000,
    },
  );
  return JSON.parse(stdout) as { ok: true; echoed: string };
}

// Open a WebSocket the way @slack/socket-mode 3 does and report the outcome.
function echoThroughSocketModeWebSocket(
  url: string,
  dispatcher: unknown,
): Promise<{ ok: true; echoed: string } | { ok: false; code?: number }> {
  const { WebSocket } = loadSocketModeUndici();
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { dispatcher } as ConstructorParameters<typeof WebSocket>[1]);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false });
    }, 5_000);
    ws.addEventListener("open", () => ws.send("hello"));
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, echoed: String(event.data) });
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ ok: false, code: event.code });
    });
  });
}

describe("slack socket mode dispatcher", () => {
  beforeEach(() => {
    clearProxyEnv();
  });

  afterEach(async () => {
    for (const close of closers.splice(0).toReversed()) {
      await close();
    }
    restoreProxyEnv();
  });

  it("keeps Socket Mode's default connection when no proxy env is set", async () => {
    const dispatchers = resolveSlackMonitorDispatchers("socket");
    expect(dispatchers.socketMode).toBeUndefined();
    await dispatchers.close();
  });

  it("builds the dispatcher from the undici copy Socket Mode uses", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const dispatchers = resolveSlackMonitorDispatchers("socket");
    try {
      expect(dispatchers.socketMode).toBeInstanceOf(loadSocketModeUndici().EnvHttpProxyAgent);
      // A shared undici copy can reuse the runtime's custom proxy routing; a
      // separate copy needs its own dispatcher for the WebSocket handshake.
      if (dispatchers.webApi instanceof loadSocketModeUndici().EnvHttpProxyAgent) {
        expect(dispatchers.socketMode).toBe(dispatchers.webApi);
      } else {
        expect(dispatchers.socketMode).not.toBe(dispatchers.webApi);
      }
    } finally {
      await dispatchers.close();
    }
  });

  it("preserves the direct fallback for a malformed proxy URL", async () => {
    process.env.HTTPS_PROXY = "://invalid-proxy";
    const dispatchers = resolveSlackMonitorDispatchers("socket");
    expect(dispatchers.socketMode).toBeUndefined();
    await dispatchers.close();
  });

  it("opens a trusted wss target through HTTPS_PROXY", async () => {
    const proxy = await startConnectProxy();
    const target = await startEchoWebSocketServer({ tls: true });
    const dir = tempDirs.make("openclaw-slack-target-ca-");
    const targetCaFile = path.join(dir, "ca.pem");
    writeFileSync(targetCaFile, PROXY_FIXTURE_CERTIFICATE);
    process.env.HTTPS_PROXY = proxy.url;

    await expect(
      echoThroughTrustedChildProcess({ proxyUrl: proxy.url, targetCaFile, targetUrl: target }),
    ).resolves.toEqual({ ok: true, echoed: "hello" });
    expect(proxy.targets).toContain(target.replace("wss://", ""));
  });

  it("trusts an HTTPS CONNECT proxy only after the managed proxy CA is configured", async () => {
    const proxy = await startConnectProxy({ tls: true });
    const target = await startEchoWebSocketServer();
    const dir = tempDirs.make("openclaw-slack-proxy-ca-");
    const proxyCaFile = path.join(dir, "ca.pem");
    writeFileSync(proxyCaFile, PROXY_FIXTURE_CERTIFICATE);
    process.env.HTTP_PROXY = proxy.url;

    const untrustedDispatchers = resolveSlackMonitorDispatchers("socket");
    try {
      await expect(
        echoThroughSocketModeWebSocket(target, untrustedDispatchers.socketMode),
      ).resolves.toMatchObject({
        ok: false,
      });
      expect(proxy.secureConnections()).toBe(0);
    } finally {
      await untrustedDispatchers.close();
    }

    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_CA_FILE = proxyCaFile;
    const trustedDispatchers = resolveSlackMonitorDispatchers("socket");
    try {
      await expect(
        echoThroughSocketModeWebSocket(target, trustedDispatchers.socketMode),
      ).resolves.toEqual({ ok: true, echoed: "hello" });
      expect(proxy.secureConnections()).toBe(1);
      expect(proxy.targets).toContain(target.replace("ws://", ""));
    } finally {
      await trustedDispatchers.close();
    }
  });

  it("opens Socket Mode's WebSocket through an HTTP CONNECT proxy", async () => {
    const proxy = await startConnectProxy();
    const target = await startEchoWebSocketServer();
    process.env.HTTPS_PROXY = proxy.url;
    process.env.HTTP_PROXY = proxy.url;

    const dispatchers = resolveSlackMonitorDispatchers("socket");
    try {
      await expect(echoThroughSocketModeWebSocket(target, dispatchers.socketMode)).resolves.toEqual(
        {
          ok: true,
          echoed: "hello",
        },
      );
      expect(proxy.targets).toContain(target.replace("ws://", ""));
    } finally {
      await dispatchers.close();
    }
  });
});
