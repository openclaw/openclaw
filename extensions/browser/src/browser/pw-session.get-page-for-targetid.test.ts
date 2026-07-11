// Browser tests cover exact Playwright page selection by CDP target id.
import { chromium, type Request, type Route } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { assertBrowserNavigationResultAllowed } from "./navigation-guard.js";
import {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  ensurePageState,
  focusPageByTargetIdViaPlaywright,
  getObservedBrowserStateViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
  setCdpConnectRetryDelayMsForTests,
} from "./pw-session.js";

vi.mock("./navigation-guard.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  };
});

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");
const navigationResultAllowedMock = vi.mocked(assertBrowserNavigationResultAllowed);

type MockPageSpec = {
  targetId?: string;
  url?: string;
  title?: string;
  targetLookupError?: string;
};

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
  pageActions: Array<{
    bringToFront: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    route: ReturnType<typeof vi.fn>;
    unroute: ReturnType<typeof vi.fn>;
  }>;
};

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const specByPage = new Map<import("playwright-core").Page, MockPageSpec>();
  const pageActions = pages.map(() => ({
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    route: vi.fn(async () => {}),
    unroute: vi.fn(async () => {}),
  }));

  const pageObjects = pages.map((spec, index) => {
    const actions = pageActions[index]!;
    const mainFrame = {};
    const page = {
      on: vi.fn(),
      route: actions.route,
      unroute: actions.unroute,
      isClosed: vi.fn(() => false),
      mainFrame: vi.fn(() => mainFrame),
      context: () => context,
      title: vi.fn(async () => spec.title ?? spec.targetId ?? `page-${index + 1}`),
      url: vi.fn(() => spec.url ?? `https://page-${index + 1}.example`),
      bringToFront: actions.bringToFront,
      close: actions.close,
    } as unknown as import("playwright-core").Page;
    specByPage.set(page, spec);
    return page;
  });

  const context: import("playwright-core").BrowserContext = {
    pages: () => pageObjects,
    on: vi.fn(),
    newCDPSession: vi.fn(async (page: import("playwright-core").Page) => {
      const spec = specByPage.get(page);
      return {
        send: vi.fn(async (method: string) => {
          if (method !== "Target.getTargetInfo") {
            return {};
          }
          if (spec?.targetLookupError) {
            throw new Error(spec.targetLookupError);
          }
          return { targetInfo: { targetId: spec?.targetId } };
        }),
        detach: vi.fn(async () => {}),
      };
    }),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages: pageObjects, pageActions };
}

function installBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const bundle = makeBrowser(pages);
  connectOverCdpSpy.mockResolvedValue(bundle.browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return bundle;
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  navigationResultAllowedMock.mockReset();
  navigationResultAllowedMock.mockImplementation(async () => {});
  setCdpConnectRetryDelayMsForTests();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session getPageForTargetId", () => {
  it("retains the active download policy for every page on the connected context", async () => {
    const { pages } = installBrowser([
      { targetId: "TARGET_A", url: "https://93.184.216.34/a" },
      { targetId: "TARGET_B", url: "https://93.184.216.34/b" },
    ]);

    await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_A",
      pageNavigationPolicy: { browserProxyMode: "explicit-browser-proxy" },
    });

    for (const page of pages) {
      expect(ensurePageState(page).downloadNavigationPolicy).toEqual({
        browserProxyMode: "explicit-browser-proxy",
      });
    }
  });

  it("keeps no-target selection when Playwright cannot resolve target ids", async () => {
    const { pages } = installBrowser([{ targetLookupError: "Not allowed" }]);

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:18792" })).resolves.toBe(pages[0]);
  });

  it("rejects an explicit target when the sole page cannot expose its target id", async () => {
    const { pageActions } = installBrowser([{ targetLookupError: "Not allowed" }]);

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "NOT_A_TAB",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    expect(pageActions[0]?.close).not.toHaveBeenCalled();
    expect(pageActions[0]?.bringToFront).not.toHaveBeenCalled();
  });

  it("does not infer target identity from duplicate URL ordering", async () => {
    installBrowser([
      { url: "https://same.example", targetLookupError: "Not allowed" },
      { url: "https://same.example", targetLookupError: "Not allowed" },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "TARGET_B", url: "https://same.example" },
          { id: "TARGET_A", url: "https://same.example" },
        ]),
        { headers: { "content-type": "application/json" } },
      ),
    );

    try {
      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "TARGET_B",
        }),
      ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("matches duplicate-URL pages only by their exact CDP target id", async () => {
    const { pages } = installBrowser([
      { targetId: "TARGET_A", url: "https://same.example" },
      { targetId: "TARGET_B", url: "https://same.example" },
    ]);

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(pages[1]);
  });

  it("guards navigation while the exact dialog-state URL check is pending", async () => {
    const safeUrl = "https://93.184.216.34/start";
    const blockedUrl = "http://169.254.169.254/latest/meta-data";
    const { pages, pageActions } = installBrowser([{ targetId: "TARGET_A", url: safeUrl }]);
    const page = pages[0]!;
    const pageAction = pageActions[0]!;
    let releaseFirstCheck!: () => void;
    navigationResultAllowedMock.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseFirstCheck = resolve;
        }),
    );

    const state = getObservedBrowserStateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_A",
      browserProxyMode: "explicit-browser-proxy",
    });
    await vi.waitFor(() => expect(navigationResultAllowedMock).toHaveBeenCalledTimes(1));
    expect(pageAction.route).toHaveBeenCalledOnce();
    const routeHandler = pageAction.route.mock.calls[0]?.[1];
    if (!routeHandler) {
      throw new Error("Expected a page navigation route handler");
    }
    const routeActions = {
      fulfill: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      fallback: vi.fn(async () => {}),
    };
    const route = {
      fulfill: routeActions.fulfill,
      abort: routeActions.abort,
      fallback: routeActions.fallback,
    } as unknown as Route;
    const request = {
      frame: () => page.mainFrame(),
      isNavigationRequest: () => true,
      resourceType: () => "document",
      url: () => blockedUrl,
    } as unknown as Request;
    await routeHandler(route, request);

    await expect(state).rejects.toThrow(
      "strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
    expect(routeActions.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(navigationResultAllowedMock).toHaveBeenNthCalledWith(1, {
      url: safeUrl,
      browserProxyMode: "explicit-browser-proxy",
    });
    releaseFirstCheck();
    await vi.waitFor(() => expect(pageAction.unroute).toHaveBeenCalledOnce());
  });

  it("focuses and closes only the exact target when URLs are identical", async () => {
    const { pageActions } = installBrowser([
      { targetId: "TARGET_A", url: "https://same.example" },
      { targetId: "TARGET_B", url: "https://same.example" },
    ]);
    const [pageA, pageB] = pageActions;

    await focusPageByTargetIdViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });
    await closePageByTargetIdViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });

    expect(pageA?.bringToFront).not.toHaveBeenCalled();
    expect(pageA?.close).not.toHaveBeenCalled();
    expect(pageB?.bringToFront).toHaveBeenCalledTimes(1);
    expect(pageB?.close).toHaveBeenCalledTimes(1);
  });

  it("does not focus or close a sole unrelated page for a stale target", async () => {
    const { pageActions } = installBrowser([{ targetId: "TARGET_A" }]);
    const [page] = pageActions;

    await expect(
      focusPageByTargetIdViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "STALE_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await expect(
      closePageByTargetIdViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "STALE_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);

    expect(page?.bringToFront).not.toHaveBeenCalled();
    expect(page?.close).not.toHaveBeenCalled();
  });

  it("evicts a stale cached page-less browser once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK", url: "https://fresh.example" }]);

    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const resolved = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });

    expect(resolved).toBe(fresh.pages[0]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("evicts a stale cached tab-selection miss once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_C", url: "https://charlie.example" },
    ]);
    const fresh = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_B", url: "https://beta.example" },
    ]);

    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:9333",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(fresh.pages[1]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("fails after a single reconnect when the refreshed browser is still page-less", async () => {
    const stale = makeBrowser([]);
    const stillBroken = makeBrowser([]);

    connectOverCdpSpy
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(stillBroken.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9444" });

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9444" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not add an extra top-level retry for non-recoverable connect failures", async () => {
    setCdpConnectRetryDelayMsForTests(0);
    connectOverCdpSpy.mockRejectedValue(new Error("connectOverCDP exploded"));
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9555" })).rejects.toThrow(
      "connectOverCDP exploded",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
  });
});
