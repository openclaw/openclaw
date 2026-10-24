import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeQaWebSessions, createQaWebPageOpener, qaWebSnapshot } from "./web-runtime.js";
import { withPendingWebPage } from "./web-runtime.pending-navigation.test-helper.js";

let server: Server | undefined;
let baseUrl: string;
let waiting: ReturnType<typeof createDeferred<void>>;
let browsers: Browser[];
const expectState = (owner: Set<string>, size: number, ...connected: boolean[]) =>
  expect({ size: owner.size, connected: browsers.map((browser) => browser.isConnected()) }).toEqual(
    { size, connected },
  );
const pageContent = { title: "QA web lifecycle", text: "owned page" };
const expectPage = (pageId: string) =>
  expect(qaWebSnapshot({ pageId })).resolves.toMatchObject(pageContent);

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
      return request.socket.destroy();
    }
    if (request.url === "/waiting") {
      return waiting.resolve();
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>QA web lifecycle</title><main>owned page</main>");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected a loopback server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const failures: unknown[] = [];
  const record = (error: unknown) => failures.push(error);
  await closeQaWebSessions().catch(record);
  for (const browser of browsers) {
    await browser.close().catch(record);
  }
  const activeServer = server;
  if (activeServer) {
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
    }).catch(record);
  }
  vi.restoreAllMocks();
  if (failures.length) {
    throw new AggregateError(failures, "QA web lifecycle fixture cleanup failed");
  }
});

it.each([false, true])("rolls back opening before a successor (cancel: %s)", async (cancel) => {
  const owner = new Set<string>();
  const controller = new AbortController();
  const reason = new Error("scenario cancelled");
  const openPage = createQaWebPageOpener(owner, cancel ? controller.signal : undefined);
  if (cancel) {
    const opening = openPage({ url: `${baseUrl}/waiting` });
    await withPendingWebPage({
      opening,
      ready: waiting.promise,
      close: () => controller.abort(reason),
      verify: async () => {
        expectState(owner, 1, true);
        controller.abort(reason);
        await expect(opening).rejects.toBe(reason);
      },
    });
    await expect(openPage({ url: baseUrl })).rejects.toBe(reason);
  } else {
    await expect(openPage({ url: `${baseUrl}/abort` })).rejects.toThrow("ERR_EMPTY_RESPONSE");
  }
  expectState(owner, 0, false);
  const successor = cancel ? createQaWebPageOpener(owner) : openPage;
  await expectPage((await successor({ url: baseUrl })).pageId);
  expectState(owner, 1, false, true);
  await closeQaWebSessions(owner);
  expectState(owner, 0, false, false);
  await expect(successor({ url: baseUrl })).rejects.toThrow("web session owner is closed");
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
      expectState(pendingOwner, 0, true, false);
    },
  });
  await expectPage(other.pageId);
  await closeQaWebSessions(otherOwner);
  expectState(otherOwner, 0, false, false);
});
