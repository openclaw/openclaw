import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeQaWebSessions, createQaWebPageOpener, qaWebSnapshot } from "./web-runtime.js";
import { withPendingWebPage } from "./web-runtime.pending-navigation.test-helper.js";

describe("QA web session ownership with Chromium", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let waiting: ReturnType<typeof createDeferred<void>>;
  let browsers: Browser[];

  beforeEach(async () => {
    browsers = [];
    waiting = createDeferred<void>();
    const launch = chromium.launch.bind(chromium);
    vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
      const browser = await launch(options);
      browsers.push(browser);
      return browser;
    });
    server = createServer((request, response) => {
      if (request.url === "/abort") {
        request.socket.destroy();
        return;
      }
      if (request.url === "/waiting") {
        waiting.resolve();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>QA web lifecycle</title><main>owned page</main>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a loopback server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await closeQaWebSessions();
    } catch (error) {
      failures.push(error);
    }
    // Assertions run before this fallback. Even a failing regression must retire
    // only the real browser handles and loopback server created by this test.
    for (const browser of browsers) {
      try {
        await browser.close();
      } catch (error) {
        failures.push(error);
      }
    }
    const activeServer = server;
    if (activeServer) {
      activeServer.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => {
          activeServer.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        failures.push(error);
      }
    }
    vi.restoreAllMocks();
    if (failures.length) {
      throw new AggregateError(failures, "QA web lifecycle fixture cleanup failed");
    }
  });

  it("rolls back failed navigation before opening and closing a successor", async () => {
    const owner = new Set<string>();
    const openPage = createQaWebPageOpener(owner);

    await expect(openPage({ url: `${baseUrl}/abort` })).rejects.toThrow("page.goto");
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false]);
    expect(owner.size).toBe(0);

    const opened = await openPage({ url: baseUrl });
    await expect(qaWebSnapshot({ pageId: opened.pageId })).resolves.toMatchObject({
      title: "QA web lifecycle",
      text: "owned page",
    });
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false, true]);
    await closeQaWebSessions(owner);
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false, false]);
    await expect(openPage({ url: baseUrl })).rejects.toThrow("web session owner is closed");
  });

  it("joins pending navigation without closing a different suite", async () => {
    const pendingOwner = new Set<string>();
    const otherOwner = new Set<string>();
    const openPending = createQaWebPageOpener(pendingOwner);
    const other = await createQaWebPageOpener(otherOwner)({ url: baseUrl });
    const opening = openPending({ url: `${baseUrl}/waiting` });

    await withPendingWebPage({
      opening,
      ready: waiting.promise,
      close: () => closeQaWebSessions(pendingOwner),
      verify: async () => {
        await Promise.all([closeQaWebSessions(pendingOwner), closeQaWebSessions(pendingOwner)]);
        await expect(opening).rejects.toBeInstanceOf(Error);
        expect(pendingOwner.size).toBe(0);
        expect(browsers.map((browser) => browser.isConnected())).toEqual([true, false]);
      },
    });
    await expect(qaWebSnapshot({ pageId: other.pageId })).resolves.toMatchObject({
      text: "owned page",
    });
    await closeQaWebSessions(otherOwner);
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false, false]);
  });

  it("cancels pending navigation before reusing the suite owner for cleanup", async () => {
    const owner = new Set<string>();
    const controller = new AbortController();
    const cancelled = new Error("scenario cancelled");
    const openPage = createQaWebPageOpener(owner, controller.signal);
    const opening = openPage({ url: `${baseUrl}/waiting` });
    await withPendingWebPage({
      opening,
      ready: waiting.promise,
      close: () => controller.abort(cancelled),
      verify: async () => {
        expect(owner.size).toBe(1);
        expect(browsers.map((browser) => browser.isConnected())).toEqual([true]);

        controller.abort(cancelled);
        await expect(opening).rejects.toBe(cancelled);
        expect(owner.size).toBe(0);
        expect(browsers.map((browser) => browser.isConnected())).toEqual([false]);
      },
    });
    await expect(openPage({ url: baseUrl })).rejects.toBe(cancelled);
    expect(browsers).toHaveLength(1);

    const openCleanupPage = createQaWebPageOpener(owner);
    const opened = await openCleanupPage({ url: baseUrl });
    await expect(qaWebSnapshot({ pageId: opened.pageId })).resolves.toMatchObject({
      title: "QA web lifecycle",
      text: "owned page",
    });
    expect(owner.size).toBe(1);
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false, true]);
    await closeQaWebSessions(owner);
    expect(owner.size).toBe(0);
    expect(browsers.map((browser) => browser.isConnected())).toEqual([false, false]);
  });
});
