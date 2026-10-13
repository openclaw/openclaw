import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { pwAi } from "./pw-ai.js";

const {
  closePlaywrightBrowserConnection,
  forceDisconnectPlaywrightForTarget,
  listPagesViaPlaywright,
} = pwAi;

const wsMockState = vi.hoisted(() => ({
  constructorUrls: [] as string[],
  constructorOptions: [] as Array<{ agent?: unknown } | undefined>,
}));

vi.mock("openclaw/plugin-sdk/websocket-runtime", () => {
  class MockWebSocket {
    static OPEN = 1;

    readyState = 0;
    private readonly handlers = new Map<string, (error?: Error) => void>();

    constructor(url: string, options?: { agent?: unknown }) {
      wsMockState.constructorUrls.push(url);
      wsMockState.constructorOptions.push(options);
      setTimeout(() => {
        this.handlers.get("error")?.(new Error("test socket should not open"));
      }, 0);
    }

    on(event: string, handler: (error?: Error) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.handlers.get("close")?.();
    }

    send() {}
  }

  return { WebSocket: MockWebSocket };
});

vi.mock(
  "./pw-session-cdp-transport.js",
  () => import("./pw-session-cdp-transport.test-support.js"),
);

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");

function installBrowserMock() {
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => "target"),
    url: vi.fn(() => "https://example.com"),
  } as unknown as import("playwright-core").Page;
  const context = {
    browser: () => browser,
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId: "TARGET_1" } } : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketEndpointSpy.mockResolvedValue({
    url: "ws://127.0.0.1:18792/devtools/browser/ROOT",
  });
  return { browserClose, page };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  wsMockState.constructorUrls = [];
  wsMockState.constructorOptions = [];
  await closePlaywrightBrowserConnection().catch(() => {});
});

const cdpUrl = "http://127.0.0.1:18792";
function targetResponse(host: string) {
  return new Response(
    JSON.stringify([
      { id: "TARGET_1", webSocketDebuggerUrl: `ws://${host}/devtools/page/TARGET_1` },
    ]),
  );
}
function discover(response: Response | Promise<Response>) {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(Promise.resolve(response));
  onTestFinished(() => {
    fetchSpy.mockRestore();
  });
  return fetchSpy;
}

describe("pw-session termination CDP SSRF guard", () => {
  it("does not terminate execution after its connection loses ownership during discovery", async () => {
    const { page } = installBrowserMock();
    await listPagesViaPlaywright({ cdpUrl });
    const discovery = createDeferred<Response>();
    const fetchSpy = discover(discovery.promise);
    onTestFinished(() => discovery.resolve(new Response("[]")));
    const termination = forceDisconnectPlaywrightForTarget({ cdpUrl, page, targetId: "TARGET_1" });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await closePlaywrightBrowserConnection({ cdpUrl });
    const replacement = installBrowserMock();
    await listPagesViaPlaywright({ cdpUrl });
    discovery.resolve(targetResponse("127.0.0.1:18792"));
    await termination;
    expect(wsMockState.constructorUrls).toEqual([]);
    expect(replacement.browserClose).not.toHaveBeenCalled();
  });

  it("blocks discovered target WebSocket URLs before best-effort termination opens a socket", async () => {
    const { browserClose, page } = installBrowserMock();
    const fetchSpy = discover(targetResponse("169.254.169.254"));
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };
    await listPagesViaPlaywright({ cdpUrl, ssrfPolicy });
    await forceDisconnectPlaywrightForTarget({ page, cdpUrl, targetId: "TARGET_1", ssrfPolicy });
    const fetchUrls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(fetchUrls).toContain(`${cdpUrl}/json/list`);
    expect(fetchUrls).not.toContain("http://169.254.169.254/json/list");
    expect(wsMockState.constructorUrls).toEqual([]);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("uses the discovered target lookup pin for best-effort termination sockets", async () => {
    const { page } = installBrowserMock();
    const lookup = vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : callback;
      if (typeof cb === "function") {
        cb(null, "127.0.0.1", 4);
      }
    });
    const assertAllowedSpy = vi
      .spyOn(await import("./cdp.helpers.js"), "assertCdpEndpointAllowed")
      .mockImplementation(async (url: string) =>
        url.includes("/devtools/page/")
          ? { hostname: "cdp-pinned.test", addresses: ["127.0.0.1"], lookup: lookup as never }
          : undefined,
      );
    onTestFinished(() => {
      assertAllowedSpy.mockRestore();
    });
    discover(targetResponse("cdp-pinned.test"));
    await listPagesViaPlaywright({ cdpUrl, ssrfPolicy: {} });
    await forceDisconnectPlaywrightForTarget({
      page,
      cdpUrl,
      targetId: "TARGET_1",
      ssrfPolicy: {},
    });
    expect(wsMockState.constructorUrls).toEqual(["ws://cdp-pinned.test/devtools/page/TARGET_1"]);
    expect(wsMockState.constructorOptions[0]?.agent).toBeDefined();
  });
});
