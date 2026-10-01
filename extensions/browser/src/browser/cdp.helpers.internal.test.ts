import { once } from "node:events";
import http, { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const sleepWithAbortMock = vi.hoisted(() =>
  vi.fn<(delayMs: number, signal?: AbortSignal, options?: { ref?: boolean }) => void>(),
);
const registerManagedProxyBrowserCdpBypassMock = vi.hoisted(() =>
  vi.fn<(url: string) => (() => void) | undefined>(() => undefined),
);

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: (...args: Parameters<typeof actual.sleepWithAbort>) => {
      const pending = actual.sleepWithAbort(...args);
      sleepWithAbortMock(...args);
      return pending;
    },
  };
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

import {
  assertCdpEndpointAllowed,
  type CdpSendFn,
  fetchCdpChecked,
  openCdpWebSocket,
  withCdpSocket,
} from "./cdp.helpers.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

const servers: Array<Server | WebSocketServer> = [];
const fixtureAuthorization = `Basic ${Buffer.from("openclaw:cdp-abort-test").toString("base64")}`;
const retryOptions = { handshakeRetries: 2, handshakeRetryDelayMs: 1, handshakeMaxRetryDelayMs: 1 };
type WsOptions = NonNullable<ConstructorParameters<typeof WebSocketServer>[0]>;
type CdpMessage = { id: number; method: string };

function port(server: Server | WebSocketServer) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listener");
  }
  return address.port;
}

function wsUrl(server: Server | WebSocketServer, host = "127.0.0.1") {
  return `ws://${host}:${port(server)}/devtools/browser/TEST`;
}

async function startWsServer(options: WsOptions = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...options });
  servers.push(server);
  await once(server, "listening");
  return server;
}

async function startHttpServer() {
  const server = createServer();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function onCommand(
  server: WebSocketServer,
  reply: (message: CdpMessage, socket: WebSocket) => void,
) {
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      reply(JSON.parse(rawDataToString(raw)) as CdpMessage, socket);
    }),
  );
}

function pinnedLookupMock(address = "127.0.0.1") {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      if (typeof options === "object" && options !== null && "all" in options) {
        cb(null, [{ address, family }]);
        return undefined as never;
      }
      cb(null, address, family);
    }
    return undefined as never;
  });
}

async function expectPromptCancellation(pending: Promise<unknown>) {
  const overdue = Promise.withResolvers<never>();
  const timeout = setTimeout(
    () => overdue.reject(new Error("CDP cancellation deadline exceeded")),
    300,
  );
  try {
    await expect(Promise.race([pending, overdue.promise])).rejects.toThrow(
      "browser request cancelled",
    );
  } finally {
    clearTimeout(timeout);
  }
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  sleepWithAbortMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe("guarded CDP fetch", () => {
  it("throws on non-http/https/ws/wss protocols under any SSRF policy", async () => {
    await expect(
      assertCdpEndpointAllowed("ftp://example.com/cdp", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).rejects.toThrow(/Invalid CDP URL protocol: ftp/);
  });

  it("releases once even when cancelling the unread response fails", async () => {
    const response = new Response("unread");
    if (!response.body) {
      throw new Error("expected a response body");
    }
    const cancel = vi
      .spyOn(response.body, "cancel")
      .mockRejectedValueOnce(new Error("cancellation failed"));
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
    const checked = await fetchCdpChecked("http://127.0.0.1:9222/json/version");
    await expect(checked.release()).resolves.toBeUndefined();
    await checked.release();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(release.mock.invocationCallOrder[0]!);
  });

  it("registers a managed-proxy bypass for the exact sanitized fetch URL", async () => {
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(),
      release: vi.fn(async () => {}),
    });
    const checked = await fetchCdpChecked("http://openclaw:secret@127.0.0.1:9222/json/version");
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/version",
    );
    expect(release).toHaveBeenCalledOnce();
    await checked.release();
  });

  it("converts SSRF-blocked errors into a browser-scoped error", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new SsrFBlockedError("blocked by policy"));
    await expect(fetchCdpChecked("http://127.0.0.1:9222/json/version")).rejects.toBeInstanceOf(
      BrowserCdpEndpointBlockedError,
    );
  });
});

describe("CDP websocket transport", () => {
  it("uses a per-connection pinned agent through withCdpSocket", async () => {
    const server = await startWsServer();
    onCommand(server, (message, socket) =>
      socket.send(JSON.stringify({ id: message.id, result: { ok: true } })),
    );
    const lookup = pinnedLookupMock();
    const globalCreateConnection = vi
      .spyOn(http.globalAgent, "createConnection")
      .mockImplementation(() => {
        throw new Error("global agent must not be used for pinned CDP sockets");
      });
    await expect(
      withCdpSocket(wsUrl(server, "cdp-pinned.test"), (send) => send("Test.ping"), {
        lookup: lookup as never,
      }),
    ).resolves.toEqual({ ok: true });
    expect(lookup).toHaveBeenCalled();
    expect(globalCreateConnection).not.toHaveBeenCalled();
  });

  it("preserves IPv6 hostnames in pinned WebSocket agent checks", async () => {
    let server: WebSocketServer;
    try {
      server = await startWsServer({ host: "::1" });
    } catch {
      return;
    }
    const ws = openCdpWebSocket(wsUrl(server, "[::1]"), {
      lookup: pinnedLookupMock("::1") as never,
    });
    try {
      await once(ws, "open");
    } finally {
      ws.close();
    }
  });

  it("blocks pinned WebSocket redirects before connecting to a new authority", async () => {
    const target = await startHttpServer();
    const redirect = await startHttpServer();
    const targetConnection = vi.fn();
    target.on("connection", targetConnection);
    redirect.on("upgrade", (_request, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${wsUrl(target)}\r\nConnection: close\r\n\r\n`);
    });
    const ws = openCdpWebSocket(wsUrl(redirect, "cdp-pinned.test"), {
      lookup: pinnedLookupMock() as never,
      playwrightTransportDefaults: true,
    });
    try {
      const error = await new Promise<Error>((resolve, reject) => {
        ws.once("open", () => reject(new Error("redirect unexpectedly opened")));
        ws.once("error", resolve);
      });
      expect(error.message).toContain("CDP WebSocket redirect changed authority");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(targetConnection).not.toHaveBeenCalled();
    } finally {
      ws.close();
    }
  });

  it("ignores malformed and uncorrelated messages before the matching response", async () => {
    const server = await startWsServer();
    const received = vi.fn();
    onCommand(server, (message, socket) => {
      received();
      socket.send(JSON.stringify({ id: "oops", method: "unrelated" }));
      socket.send("not-json");
      socket.send(JSON.stringify({ id: 99999, result: {} }));
      socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
    });
    await expect(withCdpSocket(wsUrl(server), (send) => send("Test.ping"))).resolves.toEqual({
      echoed: "Test.ping",
    });
    expect(received).toHaveBeenCalledOnce();
  });

  it("rejects in-flight calls without retrying when the socket closes", async () => {
    const server = await startWsServer();
    const callback = vi.fn(async (send: CdpSendFn) => send("Test.willClose"));
    const connection = vi.fn();
    server.on("connection", connection);
    onCommand(server, (_message, socket) => {
      setImmediate(() => socket.close());
    });
    await expect(withCdpSocket(wsUrl(server), callback, retryOptions)).rejects.toThrow(
      /CDP socket closed/,
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(connection).toHaveBeenCalledOnce();
  });

  it("retries websocket failures before any CDP command is sent", async () => {
    let rejectedHandshakes = 0;
    const server = await startWsServer({
      verifyClient: (_info, callback) => {
        if (rejectedHandshakes === 0) {
          rejectedHandshakes++;
          callback(false, 503, "try later");
        } else {
          callback(true);
        }
      },
    });
    onCommand(server, (message, socket) =>
      socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } })),
    );
    const callback = vi.fn(async (send: CdpSendFn) => send("Test.afterOpen"));
    await expect(withCdpSocket(wsUrl(server), callback, retryOptions)).resolves.toEqual({
      echoed: "Test.afterOpen",
    });
    expect(rejectedHandshakes).toBe(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("aborts an authenticated 503 retry before opening another socket", async () => {
    const controller = new AbortController();
    let rejectedHandshakes = 0;
    const server = await startWsServer({
      verifyClient: (info, callback) => {
        if (info.req.headers.authorization !== fixtureAuthorization) {
          callback(false, 401);
          return;
        }
        rejectedHandshakes++;
        callback(false, 503, "try later");
      },
    });
    const sleeping = Promise.withResolvers<void>();
    sleepWithAbortMock.mockImplementationOnce(() => sleeping.resolve());
    const pending = withCdpSocket(
      wsUrl(server, "openclaw:cdp-abort-test@127.0.0.1"),
      async () => "unexpected",
      {
        handshakeRetries: 3,
        handshakeRetryDelayMs: 2000,
        handshakeMaxRetryDelayMs: 2000,
        signal: controller.signal,
      },
    );
    await sleeping.promise;
    controller.abort(new Error("browser request cancelled"));
    await expectPromptCancellation(pending);
    expect(rejectedHandshakes).toBe(1);
  });

  it("closes an authenticated socket when its opening handshake is aborted", async () => {
    const controller = new AbortController();
    const server = await startHttpServer();
    const sockets = new Set<Socket>();
    const upgraded = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("end", () => socket.destroy());
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
    });
    server.on("upgrade", (request, socket) => {
      if (request.headers.authorization !== fixtureAuthorization) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.resume();
      upgraded.resolve();
    });
    try {
      const pending = withCdpSocket(
        wsUrl(server, "openclaw:cdp-abort-test@127.0.0.1"),
        async () => "unexpected",
        {
          handshakeTimeoutMs: 2000,
          handshakeRetries: 0,
          signal: controller.signal,
        },
      );
      await upgraded.promise;
      controller.abort(new Error("browser request cancelled"));
      await expectPromptCancellation(pending);
      await closed.promise;
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  });

  it("does not retry rate-limited websocket handshakes", async () => {
    let rejectedHandshakes = 0;
    const server = await startWsServer({
      verifyClient: (_info, callback) => {
        rejectedHandshakes++;
        callback(false, 429, "too many requests");
      },
    });
    await expect(
      withCdpSocket(wsUrl(server), (send) => send("Test.neverRuns"), retryOptions),
    ).rejects.toThrow(/429/);
    expect(rejectedHandshakes).toBe(1);
  });

  it("keeps an admitted write socket available for compensation after caller abort", async () => {
    const server = await startWsServer();
    const controller = new AbortController();
    const cancellation = new Error("browser request cancelled after target creation");
    const commands: string[] = [];
    onCommand(server, (message, socket) => {
      commands.push(message.method);
      if (message.method === "Target.createTarget") {
        controller.abort(cancellation);
      }
      socket.send(JSON.stringify({ id: message.id, result: { targetId: "created-target" } }));
    });
    await expect(
      withCdpSocket(
        wsUrl(server),
        async (send) => {
          const created = (await send("Target.createTarget", { url: "about:blank" })) as {
            targetId: string;
          };
          try {
            controller.signal.throwIfAborted();
          } catch (error) {
            await send("Target.closeTarget", { targetId: created.targetId });
            throw error;
          }
        },
        { signal: controller.signal, commandTimeoutMs: 1000 },
      ),
    ).rejects.toBe(cancellation);
    expect(commands).toEqual(["Target.createTarget", "Target.closeTarget"]);
  });

  it("rejects and closes the socket when a CDP command exceeds its timeout", async () => {
    const server = await startWsServer();
    const closed = Promise.withResolvers<void>();
    server.on("connection", (socket) => socket.once("close", () => closed.resolve()));
    await expect(
      withCdpSocket(wsUrl(server), (send) => send("Page.captureScreenshot"), {
        commandTimeoutMs: 5,
      }),
    ).rejects.toThrow(/CDP command Page\.captureScreenshot timed out after 5ms/);
    await closed.promise;
  });

  it("rejects and rethrows when the WebSocket fails to open", async () => {
    await expect(
      withCdpSocket("ws://127.0.0.1:1/devtools/browser/NO", async () => "unreachable"),
    ).rejects.toThrow(/ECONNREFUSED|CDP socket closed/);
  });

  it("keeps WebSocket credentials out of the URL and managed-proxy bypass", async () => {
    const server = await startWsServer();
    const authorization = Promise.withResolvers<string | undefined>();
    server.once("connection", (socket, request) => {
      authorization.resolve(request.headers.authorization);
      socket.close();
    });
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    const ws = openCdpWebSocket(wsUrl(server, "alice:p%40ss@127.0.0.1"), {
      handshakeTimeoutMs: 500,
    });
    try {
      await once(ws, "open");
      expect(ws.url).toBe(wsUrl(server));
      expect(await authorization.promise).toBe(
        `Basic ${Buffer.from("alice:p@ss").toString("base64")}`,
      );
      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(wsUrl(server));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      ws.close();
    }
  });
});
