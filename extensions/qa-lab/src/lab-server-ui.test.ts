import { on, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type NetConnectOpts, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectContentType,
  missingUiHtml,
  proxyUpgradeRequest,
  tryResolveUiAsset,
} from "./lab-server-ui.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeUiDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("qa-lab server ui helpers", () => {
  it("detects basic UI asset content types", () => {
    expect(detectContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(detectContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(detectContentType("main.js")).toBe("text/javascript; charset=utf-8");
    expect(detectContentType("icon.svg")).toBe("image/svg+xml");
  });

  it("renders the missing-ui placeholder html", () => {
    expect(missingUiHtml()).toContain("QA Lab UI not built");
    expect(missingUiHtml()).toContain("pnpm qa:lab:build");
  });

  it("never resolves sibling files outside the UI dist root", async () => {
    const rootDir = await makeUiDir();
    const uiDistDir = path.join(rootDir, "dist");
    const siblingDir = path.join(rootDir, "dist-other");
    await mkdir(uiDistDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(uiDistDir, "index.html"), "bundle-root", "utf8");
    await writeFile(path.join(siblingDir, "secret.txt"), "sibling-secret", "utf8");

    expect(tryResolveUiAsset("/", uiDistDir, rootDir)).toBe(path.join(uiDistDir, "index.html"));
    expect(tryResolveUiAsset("/../dist-other/secret.txt", uiDistDir, rootDir)).toBeNull();
  });

  it("rejects malformed percent-encoded UI asset paths", async () => {
    const uiDistDir = await makeUiDir();
    await writeFile(path.join(uiDistDir, "index.html"), "bundle-root", "utf8");

    expect(tryResolveUiAsset("/%E0%A4", uiDistDir, uiDistDir)).toBeNull();
  });
});

const UPGRADE_RESPONSE = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n";
const BAD_GATEWAY_RESPONSE = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n";
const GATEWAY_TIMEOUT_RESPONSE = "HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n";

const TEST_TLS_OPTIONS = {
  cert: PROXY_FIXTURE_CERTIFICATE,
  key: PROXY_FIXTURE_KEY,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
} as const;

function trackServer<T extends Server>(server: T): T {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
  return server;
}

async function listenLoopback(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback server did not expose a TCP port");
  }
  return address.port;
}

async function openBrowserPair(): Promise<{ browser: Socket; proxySocket: Socket }> {
  const server = trackServer(net.createServer({ allowHalfOpen: true }));
  const port = await listenLoopback(server);
  const connected = once(server, "connection");
  const browser = net.connect({ host: "127.0.0.1", port });
  await once(browser, "connect");
  const proxySocket: Socket = (await connected)[0];
  cleanups.push(async () => {
    browser.destroy();
    proxySocket.destroy();
  });
  return { browser, proxySocket };
}

function runUpgradeProxy(socket: Socket, target: string) {
  proxyUpgradeRequest({
    req: {
      httpVersion: "1.1",
      method: "GET",
      rawHeaders: ["Host", "ignored.local", "Connection", "Upgrade", "Upgrade", "websocket"],
      url: "/control-ui/socket?client=qa",
    } as never,
    socket,
    head: Buffer.alloc(0),
    target: new URL(target),
  });
}

async function readSocket(socket: Socket, marker?: string, timeoutMs = 2_000): Promise<string> {
  let body = "";
  // The event iterator owns listener cleanup without destroying an upgraded socket.
  for await (const event of on(socket, "data", {
    signal: AbortSignal.timeout(timeoutMs),
    close: ["end", "close"],
  })) {
    const chunk: Buffer = event[0];
    body += chunk.toString("utf8");
    if (marker && body.includes(marker)) {
      return body;
    }
  }
  if (marker || !socket.readableEnded) {
    throw new Error(`socket closed before ${marker ?? "a clean end"}`);
  }
  return body;
}

async function expectOpeningFailure(kind: "tls" | "reset") {
  const accepted = Promise.withResolvers<Socket>();
  const server = trackServer(
    net.createServer((socket) => {
      if (kind === "tls") {
        socket.resume();
      } else {
        socket.once("data", () => socket.resetAndDestroy());
      }
      accepted.resolve(socket);
    }),
  );
  const port = await listenLoopback(server, "localhost");
  const { browser, proxySocket } = await openBrowserPair();
  const endSpy = vi.spyOn(proxySocket, "end");
  const timeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
  const response = kind === "tls" ? GATEWAY_TIMEOUT_RESPONSE : BAD_GATEWAY_RESPONSE;
  const responsePromise = readSocket(browser, undefined, kind === "tls" ? 14_000 : 2_000);
  runUpgradeProxy(proxySocket, `${kind === "tls" ? "https" : "http"}://localhost:${port}`);
  const upstream = await accepted.promise;
  const closed = once(upstream, "close");
  await expect(responsePromise).resolves.toBe(response);
  await closed;
  expect(endSpy).toHaveBeenCalledWith(response, expect.any(Function));
  expect([upstream.destroyed, proxySocket.destroyed]).toEqual([true, true]);
  if (kind === "tls") {
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  }
}

describe("proxyUpgradeRequest loopback transport", () => {
  it("forwards HTTPS upgrades only after the TLS handshake and clears the opening timeout", async () => {
    const connectTls = tls.connect;
    vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) =>
      connectTls({
        ...options,
        ...TEST_TLS_OPTIONS,
        rejectUnauthorized: false,
      })) as typeof tls.connect);

    const request = Promise.withResolvers<string>();
    const upstreamServer = trackServer(
      tls.createServer(TEST_TLS_OPTIONS, (socket) => {
        void readSocket(socket, "\r\n\r\n").then((data) => {
          request.resolve(data);
          socket.write(UPGRADE_RESPONSE);
        }, request.reject);
      }),
    );
    const upstreamPort = await listenLoopback(upstreamServer, "localhost");
    const { browser, proxySocket } = await openBrowserPair();
    const setTimeoutSpy = vi.spyOn(net.Socket.prototype, "setTimeout");
    const removeListenerSpy = vi.spyOn(net.Socket.prototype, "removeListener");
    const responsePromise = readSocket(browser, "\r\n\r\n");

    runUpgradeProxy(proxySocket, `https://localhost:${upstreamPort}`);

    await expect(request.promise).resolves.toContain("GET /socket?client=qa HTTP/1.1");
    await expect(responsePromise).resolves.toBe(UPGRADE_RESPONSE);
    expect(setTimeoutSpy).toHaveBeenCalledWith(10_000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(0);
    expect(removeListenerSpy.mock.calls.some(([event]) => event === "timeout")).toBe(true);
  });

  it("returns a flushed 504 and closes both sockets when TLS stays silent after TCP connect", async () => {
    await expectOpeningFailure("tls");
  }, 16_000);

  it("closes a connecting upstream exactly once when the browser sends EOF", async () => {
    const upstreamServer = trackServer(net.createServer());
    const upstreamPort = await listenLoopback(upstreamServer);
    const { browser, proxySocket } = await openBrowserPair();
    const upstream = new net.Socket();
    const destroySpy = vi.spyOn(upstream, "destroy");
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(net, "connect").mockImplementationOnce(((options: NetConnectOpts) => {
      connectTimer = setTimeout(() => {
        if (!upstream.destroyed) {
          upstream.connect(options);
        }
      }, 50);
      return upstream;
    }) as typeof net.connect);
    cleanups.push(async () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
      }
      upstream.destroy();
    });
    const proxyEnded = once(proxySocket, "end");

    runUpgradeProxy(proxySocket, `http://127.0.0.1:${upstreamPort}`);
    browser.end();

    await proxyEnded;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("returns a flushed 502 when the upstream resets before its upgrade response", async () => {
    await expectOpeningFailure("reset");
  });
});
