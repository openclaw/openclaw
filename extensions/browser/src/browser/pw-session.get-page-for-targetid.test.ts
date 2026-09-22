// Browser tests cover exact Playwright page selection by CDP target id.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { pwAi } from "./pw-ai.js";
import { markTargetBlocked } from "./pw-session-connection.js";

const {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  focusPageByTargetIdViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
} = pwAi;

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");

vi.mock(
  "./pw-session-cdp-transport.js",
  () => import("./pw-session-cdp-transport.test-support.js"),
);

type MockPageSpec = {
  targetId?: string;
  url?: string;
  title?: string;
  beforeTargetLookup?: () => Promise<void>;
  targetLookupError?: string;
  navigateDuringTargetLookup?: boolean;
  subframeNavigationDuringTargetLookup?: boolean;
};

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
  pageHandlers: Array<Map<string, Array<(...args: unknown[]) => void>>>;
  pageActions: Array<{
    bringToFront: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>;
};

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const specByPage = new Map<import("playwright-core").Page, MockPageSpec>();
  const pageActions = pages.map(() => ({
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));
  const pageHandlers = pages.map(() => new Map<string, Array<(...args: unknown[]) => void>>());

  const pageObjects = pages.map((spec, index) => {
    const actions = pageActions[index]!;
    const handlers = pageHandlers[index]!;
    const mainFrame = { url: () => spec.url ?? `https://page-${index + 1}.example` };
    const page = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      context: () => context,
      mainFrame: () => mainFrame,
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
          await spec?.beforeTargetLookup?.();
          if (spec?.targetLookupError) {
            throw new Error(spec.targetLookupError);
          }
          if (spec?.navigateDuringTargetLookup) {
            const pageIndex = pageObjects.indexOf(page);
            pageHandlers[pageIndex]?.get("framenavigated")?.[0]?.(page.mainFrame());
          }
          if (spec?.subframeNavigationDuringTargetLookup) {
            const pageIndex = pageObjects.indexOf(page);
            pageHandlers[pageIndex]?.get("framenavigated")?.[0]?.({
              url: () => "https://frame.example/new",
            });
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

  return { browser, browserClose, pages: pageObjects, pageHandlers, pageActions };
}

function installBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const bundle = makeBrowser(pages);
  connectOverCdpSpy.mockResolvedValue(bundle.browser);
  getChromeWebSocketEndpointSpy.mockResolvedValue(null);
  return bundle;
}

afterEach(async () => {
  vi.useRealTimers();
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session getPageForTargetId", () => {
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

  it("selects a healthy target within one probe window despite stuck sibling tabs", async () => {
    vi.useFakeTimers();
    const { pages } = installBrowser([
      ...Array.from({ length: 10 }, (_, index) => ({
        targetId: `STUCK_${index}`,
        beforeTargetLookup: () => new Promise<void>(() => {}),
      })),
      { targetId: "HEALTHY" },
    ]);
    let resolved: import("playwright-core").Page | undefined;
    const selection = getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "HEALTHY",
    }).then((page) => {
      resolved = page;
    });

    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolved).toBe(pages[10]);
    } finally {
      await vi.runAllTimersAsync();
      await selection;
    }
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
    getChromeWebSocketEndpointSpy.mockResolvedValue(null);

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
    getChromeWebSocketEndpointSpy.mockResolvedValue(null);

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:9333",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(fresh.pages[1]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a replacement connection when an older selection finishes after recovery", async () => {
    const cdpUrl = "http://127.0.0.1:9333";
    const lookupStarted = createDeferred<void>();
    const finishLookup = createDeferred<void>();
    const stalePage: MockPageSpec = { targetId: "OLD_TARGET" };
    const stale = makeBrowser([stalePage]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK" }]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    getChromeWebSocketEndpointSpy.mockResolvedValue(null);
    await getPageForTargetId({ cdpUrl });

    stalePage.beforeTargetLookup = () => {
      lookupStarted.resolve();
      return finishLookup.promise;
    };
    const selection = getPageForTargetId({ cdpUrl, targetId: "TARGET_OK" });
    await lookupStarted.promise;
    await closePlaywrightBrowserConnection({ cdpUrl });
    await expect(getPageForTargetId({ cdpUrl, targetId: "TARGET_OK" })).resolves.toBe(
      fresh.pages[0],
    );
    finishLookup.resolve();

    await expect(selection).resolves.toBe(fresh.pages[0]);
    expect(fresh.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves blocked targets when reconnecting after a stale selection", async () => {
    const cdpUrl = "http://127.0.0.1:9333";
    const stale = makeBrowser([{ targetId: "OLD_TARGET" }]);
    const fresh = makeBrowser([{ targetId: "BLOCKED" }, { targetId: "HEALTHY" }]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    getChromeWebSocketEndpointSpy.mockResolvedValue(null);
    await getPageForTargetId({ cdpUrl });
    markTargetBlocked(cdpUrl, "BLOCKED");

    await expect(getPageForTargetId({ cdpUrl, targetId: "HEALTHY" })).resolves.toBe(fresh.pages[1]);
    await expect(getPageForTargetId({ cdpUrl })).resolves.toBe(fresh.pages[1]);
    await expect(getPageForTargetId({ cdpUrl, targetId: "BLOCKED" })).rejects.toThrow(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    await expect(getPageForTargetId({ cdpUrl, targetId: "MISSING_TARGET" })).rejects.toBeInstanceOf(
      BrowserTabNotFoundError,
    );
    await expect(getPageForTargetId({ cdpUrl })).resolves.toBe(fresh.pages[1]);
  });

  it("fails after a single reconnect when the refreshed browser is still page-less", async () => {
    const stale = makeBrowser([]);
    const stillBroken = makeBrowser([]);

    connectOverCdpSpy
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(stillBroken.browser);
    getChromeWebSocketEndpointSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9444" });

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9444" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not add an extra top-level retry for non-recoverable connect failures", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const discoveryStarted = createDeferred<void>();
      connectOverCdpSpy.mockRejectedValue(new Error("connectOverCDP exploded"));
      getChromeWebSocketEndpointSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      await Promise.all([
        expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9555" })).rejects.toThrow(
          "connectOverCDP exploded",
        ),
        discoveryStarted.promise.then(() => vi.runAllTimersAsync()),
      ]);
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
