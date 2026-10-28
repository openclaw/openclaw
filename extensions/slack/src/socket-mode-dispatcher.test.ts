import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { resolveSlackMonitorDispatchers } from "./client-options.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const closers: Array<() => Promise<void> | void> = [];
const execFileAsync = promisify(execFile);
function writeCa() {
  const file = path.join(tempDirs.make("openclaw-slack-ca-"), "ca.pem");
  writeFileSync(file, PROXY_FIXTURE_CERTIFICATE);
  return file;
}

// Resolve the installed SDK dependency without Bun's bare-undici builtin alias.
type SocketModeUndici = typeof import("undici");
function loadSocketModeUndici(): SocketModeUndici {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromBolt = createRequire(requireFromTest.resolve("@slack/bolt/package.json"));
  const requireFromSocketMode = createRequire(
    requireFromBolt.resolve("@slack/socket-mode/package.json"),
  );
  return requireFromSocketMode("undici/index.js") as SocketModeUndici;
}

function closeServer(server: http.Server | https.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startConnectProxy(options: { tls?: boolean } = {}) {
  const targets: string[] = [];
  let secureConnections = 0;
  const server = options.tls
    ? https.createServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE })
    : http.createServer();
  server.on("secureConnection", () => {
    secureConnections += 1;
  });
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
  await once(server.listen(0, "127.0.0.1"), "listening");
  closers.push(() => closeServer(server));
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
    await once(server.listen(0, "127.0.0.1"), "listening");
  } else {
    await once(wss, "listening");
  }
  closers.push(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    const closed = once(wss, "close");
    wss.close();
    await closed;
    if (server) {
      await closeServer(server);
    }
  });
  const address = (server ?? wss).address() as AddressInfo;
  return `${options.tls ? "wss" : "ws"}://127.0.0.1:${address.port}`;
}

async function echoThroughTrustedChildProcess(options: {
  proxyUrl: string;
  signal: AbortSignal;
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
    const { WebSocket } = requireFromSocketMode("undici/index.js");
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
  const completed = execFileAsync(
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
      signal: options.signal,
    },
  );
  // An abort rejects execFile before the child closes; join it before fixture teardown.
  const closed = new Promise<void>((resolve) => {
    completed.child.once("close", () => resolve());
  });
  closers.push(() => closed);
  const { stdout } = await completed;
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

function expectEcho(target: string, dispatcher: unknown) {
  return expect(echoThroughSocketModeWebSocket(target, dispatcher)).resolves.toEqual({
    ok: true,
    echoed: "hello",
  });
}

async function withDispatchers(
  run: (dispatchers: ReturnType<typeof resolveSlackMonitorDispatchers>) => Promise<void>,
) {
  const dispatchers = resolveSlackMonitorDispatchers("socket");
  try {
    await run(dispatchers);
  } finally {
    await dispatchers.close();
  }
}

describe("slack socket mode dispatcher", () => {
  beforeEach(() => {
    for (const key of PROXY_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(async () => {
    for (const close of closers.splice(0).toReversed()) {
      await close();
    }
    vi.unstubAllEnvs();
  });

  it.each([undefined, "://invalid-proxy"])(
    "preserves direct connections for proxy %s",
    async (proxy) => {
      vi.stubEnv("HTTPS_PROXY", proxy);
      await withDispatchers(async ({ socketMode }) => expect(socketMode).toBeUndefined());
    },
  );

  it("opens a trusted wss target through HTTPS_PROXY", async ({ signal }) => {
    const proxy = await startConnectProxy();
    const target = await startEchoWebSocketServer({ tls: true });
    process.env.HTTPS_PROXY = proxy.url;

    await expect(
      echoThroughTrustedChildProcess({
        proxyUrl: proxy.url,
        signal,
        targetCaFile: writeCa(),
        targetUrl: target,
      }),
    ).resolves.toEqual({ ok: true, echoed: "hello" });
    expect(proxy.targets).toContain(target.replace("wss://", ""));
  });

  it("trusts an HTTPS CONNECT proxy only after the managed proxy CA is configured", async () => {
    const proxy = await startConnectProxy({ tls: true });
    const target = await startEchoWebSocketServer();
    process.env.HTTP_PROXY = proxy.url;

    await withDispatchers(async ({ socketMode }) => {
      await expect(echoThroughSocketModeWebSocket(target, socketMode)).resolves.toMatchObject({
        ok: false,
      });
      expect(proxy.secureConnections()).toBe(0);
    });

    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_CA_FILE = writeCa();
    await withDispatchers(async ({ socketMode }) => {
      await expectEcho(target, socketMode);
      expect(proxy.secureConnections()).toBe(1);
      expect(proxy.targets).toContain(target.replace("ws://", ""));
    });
  });

  it("opens Socket Mode's WebSocket through an HTTP CONNECT proxy", async () => {
    const proxy = await startConnectProxy();
    const target = await startEchoWebSocketServer();
    process.env.HTTPS_PROXY = proxy.url;
    process.env.HTTP_PROXY = proxy.url;

    await withDispatchers(async (dispatchers) => {
      expect(dispatchers.socketMode).toBeInstanceOf(loadSocketModeUndici().EnvHttpProxyAgent);
      if (dispatchers.webApi instanceof loadSocketModeUndici().EnvHttpProxyAgent) {
        expect(dispatchers.socketMode).toBe(dispatchers.webApi);
      } else {
        expect(dispatchers.socketMode).not.toBe(dispatchers.webApi);
      }
      await expectEcho(target, dispatchers.socketMode);
      expect(proxy.targets).toContain(target.replace("ws://", ""));
    });
  });
});
