import { once } from "node:events";
import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { type ConnectOverCDPTransport, chromium } from "playwright-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";
import { makeTargetBrowser } from "./pw-session.browser.test-support.js";

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));
const { closePlaywrightBrowserConnection, listPagesViaPlaywright } = pwAi;
const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");

function pinnedLoopbackLookup() {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      cb(null, "127.0.0.1", 4);
    }
  }) as never;
}

function inspectTransport(inspect: (transport: ConnectOverCDPTransport) => Promise<void>) {
  connectOverCdpSpy.mockImplementationOnce(async (value: unknown) => {
    expect(typeof value).not.toBe("string");
    await inspect(value as ConnectOverCDPTransport);
    return makeTargetBrowser("A", "https://example.com").browser;
  });
}

async function openServer() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  onTestFinished(async () => {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  await once(server, "listening");
  const socket = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  const cdpUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/test`;
  getChromeWebSocketEndpointSpy.mockResolvedValue({ url: cdpUrl, lookup: pinnedLoopbackLookup() });
  return { server, socket, cdpUrl };
}

async function listPages(cdpUrl: string) {
  await expect(listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} })).resolves.toEqual([
    expect.objectContaining({ targetId: "A" }),
  ]);
  expect(connectOverCdpSpy).toHaveBeenCalledOnce();
}

async function inspectSocket(
  run: (transport: ConnectOverCDPTransport, socket: WebSocket) => Promise<void>,
) {
  const { socket, cdpUrl } = await openServer();
  inspectTransport(async (transport) => run(transport, await socket));
  await listPages(cdpUrl);
}

async function connectPrepared(wire: ConnectOverCDPTransport) {
  await connectOverCdpTransport("ws://127.0.0.1/unused", {
    timeout: 1000,
    headers: {},
    preparedTransport: wire,
  });
}

function attachedTarget(targetInfo: object, sessionId?: string) {
  return {
    method: "Target.attachedToTarget",
    sessionId,
    params: { sessionId: "worker-session", targetInfo, waitingForDebugger: true },
  };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session Playwright CDP transport", () => {
  it("keeps HTTP fallback managed and resumes root contextless targets before detaching", async () => {
    const { server, socket: connected, cdpUrl: transportUrl } = await openServer();
    const commands: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
      [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const command = JSON.parse(rawDataToString(data)) as (typeof commands)[number];
        commands.push(command);
        if (command.method !== "Runtime.runIfWaitingForDebugger") {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
        }
      });
    });
    getChromeWebSocketEndpointSpy
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: transportUrl });
    inspectTransport(async (transport) => {
      const delivered: object[] = [];
      Object.assign(transport, { onmessage: (message: object) => delivered.push(message) });
      const socket = await connected;
      socket.send(JSON.stringify(attachedTarget({ targetId: "worker", type: "worker" })));
      const forwarded = [
        attachedTarget({ type: "browser" }),
        attachedTarget({ type: "page", browserContextId: "default-context" }),
        attachedTarget({ type: "worker" }, "parent-session"),
      ];
      for (const event of forwarded) {
        socket.send(JSON.stringify(event));
      }
      await vi.waitFor(() => expect(delivered).toEqual(forwarded));
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      const [resume] = commands;
      if (!resume) {
        throw new Error("missing contextless-target resume command");
      }
      expect(resume).toMatchObject({
        id: expect.any(Number),
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "worker-session",
      });
      socket.send(JSON.stringify({ id: resume.id, result: {} }));
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      expect(commands[1]).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: "worker-session" },
      });
      const closed = once(socket, "close");
      transport.close();
      await closed;
      expect(delivered).toEqual(forwarded);
      expect(commands).toHaveLength(2);
    });
    const cdpUrl = transportUrl.replace("ws:", "http:").replace("/devtools/browser/test", "");
    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
      expect.objectContaining({ targetId: "A" }),
    ]);
  });

  it("suppresses a root contextless target with no session id without closing", async () => {
    const send = vi.fn();
    const close = vi.fn();
    const wire: ConnectOverCDPTransport = { send, close };
    inspectTransport(async (transport) => {
      const delivered = createDeferred<object>();
      Object.assign(transport, { onmessage: delivered.resolve });
      wire.onmessage?.({
        method: "Target.attachedToTarget",
        params: {
          targetInfo: { targetId: "sessionless-worker", type: "service_worker" },
          waitingForDebugger: true,
        },
      });
      const followup = { id: 42, result: { ok: true } };
      wire.onmessage?.(followup);
      await expect(delivered.promise).resolves.toEqual(followup);
      expect(send).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
    await connectPrepared(wire);
  });

  it("follows same-authority redirects in the pinned Playwright CDP transport", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const paths: string[] = [];
    wss.on("connection", (socket, request) => {
      expect(request.headers["user-agent"]).toContain("Playwright/");
      expect(request.headers["sec-websocket-extensions"]).toContain("permessage-deflate");
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as { id?: number };
        socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
      });
    });
    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/start") {
        socket.write(
          "HTTP/1.1 302 Found\r\nLocation: /devtools/browser/redirected\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      paths.push(request.url ?? "");
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    onTestFinished(async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    });
    const port = await listenOnLoopback(server);
    const cdpUrl = `ws://127.0.0.1:${port}/start`;
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: cdpUrl,
      lookup: pinnedLoopbackLookup(),
    });
    inspectTransport(async (transport) => {
      const message = createDeferred<object>();
      const receive = vi.fn(message.resolve);
      Object.assign(transport, { onmessage: receive });
      transport.send({ id: 8, method: "Browser.getVersion" });
      expect(receive).not.toHaveBeenCalled();
      await expect(message.promise).resolves.toStrictEqual({ id: 8, result: { ok: true } });
      transport.close();
    });
    await listPages(cdpUrl);
    expect(paths).toStrictEqual(["/devtools/browser/redirected"]);
  });

  it("delivers queued CDP messages before reporting pinned transport closure", async () => {
    await inspectSocket(async (transport, socket) => {
      const events: string[] = [];
      const closed = createDeferred<void>();
      Object.assign(transport, {
        onmessage: () => events.push("message"),
        onclose: () => {
          events.push("close");
          closed.resolve();
        },
      });
      socket.send(JSON.stringify({ id: 1, result: { ok: true } }));
      socket.close();
      await closed.promise;
      expect(events).toStrictEqual(["message", "close"]);
    });
  });

  it("retires a borrowed transport after rejected async delivery without inventing close acknowledgement", async () => {
    const closeRequested = createDeferred<void>();
    const close = vi.fn(closeRequested.resolve);
    const wire: ConnectOverCDPTransport = { send: vi.fn(), close };
    // Playwright types this callback as void, but CRConnection installs an async receiver.
    const handler = vi
      .fn<NonNullable<ConnectOverCDPTransport["onmessage"]>>()
      .mockRejectedValue(new Error("async handler failed"));
    const closeNotified = createDeferred<void>();
    const closed = vi.fn<(reason?: string) => void>(() => closeNotified.resolve());
    inspectTransport(async (transport) => {
      Object.assign(transport, { onmessage: handler, onclose: closed });
    });
    await connectPrepared(wire);
    wire.onmessage?.({ id: 1, result: {} });
    wire.onmessage?.({ id: 2, result: {} });
    await closeRequested.promise;
    expect(closed).not.toHaveBeenCalled();
    wire.onclose?.("owner cleanup acknowledged");
    await closeNotified.promise;
    expect(close).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledExactlyOnceWith("async handler failed");
  });

  it.each([
    ["malformed JSON", "CDP socket closed"],
    ["failed delivery", "handler failed"],
    ["protocol error", "Invalid WebSocket frame"],
  ])("closes the pinned transport on %s", async (failure, reason) => {
    await inspectSocket(async (transport, socket) => {
      const closed = createDeferred<string | undefined>();
      Object.assign(transport, { onclose: closed.resolve });
      if (failure === "malformed JSON") {
        socket.send("{not-json");
      } else if (failure === "failed delivery") {
        Object.assign(transport, {
          onmessage: () => {
            throw new Error(reason);
          },
        });
        socket.send(JSON.stringify({ id: 1, result: {} }));
      } else {
        const rawSocket = Reflect.get(socket, "_socket") as { write(data: Buffer): void };
        // Invalid reserved opcode exercises the real ws client's protocol error.
        rawSocket.write(Buffer.from([0x83, 0x00]));
      }
      if (failure === "malformed JSON") {
        await expect(closed.promise).resolves.toBe(reason);
      } else {
        await expect(closed.promise).resolves.toContain(reason);
      }
    });
  });
});
