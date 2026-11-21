import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { clickViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";

const { connectOverCdpMock } = vi.hoisted(() => ({
  connectOverCdpMock: vi.fn<(transport: ConnectOverCDPTransport) => Promise<Browser>>(),
}));

// mock-isolation: Exercise the CDP transport without launching a real Playwright browser.
vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightUserAgent: () => "Playwright/test",
  getPlaywrightCore: () => ({ chromium: { connectOverCDP: connectOverCdpMock }, devices: {} }),
}));

let cdpUrl: string;
const discoveryRequests = vi.fn();
const socketPath = "/devtools/browser/test";
const server = createServer((request, response) => {
  discoveryRequests(request.url);
  if (request.url !== "/json/version") {
    response.writeHead(404).end();
    return;
  }
  const webSocketDebuggerUrl = `${cdpUrl.replace("http:", "ws:")}${socketPath}`;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ webSocketDebuggerUrl }));
});
const socketServer = new WebSocketServer({ server, path: socketPath });
const socketConnections = vi.fn();
socketServer.on("connection", socketConnections);

function createPage(targetId: string, snapshotText: string) {
  const session = {
    send: vi.fn().mockResolvedValue({ targetInfo: { targetId } }),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  const click = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn().mockReturnValue({ click });
  const context = { newCDPSession: vi.fn().mockResolvedValue(session) };
  const page = {
    context: () => context,
    locator,
    on: vi.fn(),
    off: vi.fn(),
    url: vi.fn(() => `https://example.test/${targetId}`),
    ariaSnapshot: vi.fn().mockResolvedValue(snapshotText),
  };
  return { page, session, locator, click };
}

function createBrowser(pages: unknown[]) {
  const events = new EventEmitter();
  const context = { pages: () => pages, on: vi.fn() };
  connectOverCdpMock.mockImplementation(async (transport) => {
    const closed = once(events, "disconnected");
    const browser = {
      contexts: () => [context],
      on: events.on.bind(events),
      off: events.off.bind(events),
      close: async () => {
        transport.close();
        await closed;
      },
    } as unknown as Browser;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's transport owns this callback.
    transport.onclose = () => events.emit("disconnected", browser);
    return browser;
  });
}

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cdpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  const socketClosures = [...socketServer.clients].map((socket) => once(socket, "close"));
  await closePlaywrightBrowserConnection();
  await Promise.all(socketClosures);
  expect(socketServer.clients.size).toBe(0);
  vi.clearAllMocks();
});

afterAll(async () => {
  for (const endpoint of [socketServer, server]) {
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it.each(["e", ""])("uses %s refs on the selected target over one connection", async (prefix) => {
  const [buttonRef, linkRef] = [`${prefix}1`, `${prefix}2`] as const;
  const text = `- button "OK" [ref=${buttonRef}]\n- link "Docs" [ref=${linkRef}]`;
  const p1 = createPage("T1", "OTHER PAGE");
  const p2 = createPage("T2", text);
  createBrowser([p1.page, p2.page]);

  const res = await snapshotRoleViaPlaywright({ refsMode: "aria", cdpUrl, targetId: "T2" });
  expect(res.snapshot).toBe(text);
  expect(res.refs).toEqual({
    [buttonRef]: { role: "button", name: "OK" },
    [linkRef]: { role: "link", name: "Docs" },
  });
  expect(p1.session.detach).toHaveBeenCalled();
  expect(p2.session.detach).toHaveBeenCalled();
  expect(p2.page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
  expect(p2.page.off).toHaveBeenCalledWith("framedetached", expect.any(Function));
  await clickViaPlaywright({ cdpUrl, targetId: "T2", ref: buttonRef });

  expect(p2.locator).toHaveBeenCalledWith(`aria-ref=${buttonRef}`);
  expect(p2.click).toHaveBeenCalledTimes(1);
  expect(p1.click).not.toHaveBeenCalled();
  expect(connectOverCdpMock).toHaveBeenCalledTimes(1);
  expect(socketConnections).toHaveBeenCalledTimes(1);
  expect(socketServer.clients.size).toBe(1);
  expect(discoveryRequests).toHaveBeenCalledExactlyOnceWith("/json/version");
});
