import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { pwAi } from "./pw-ai.js";
import { closeConnectionScopedPageBrowser, markTargetBlocked } from "./pw-session-connection.js";

const {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  focusPageByTargetIdViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
  retirePlaywrightBrowserConnectionExact,
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
};

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
  pageActions: Array<{
    bringToFront: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>;
};

const cdpUrl = "http://127.0.0.1:18792";

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  let connected = true;
  const browserClose = vi.fn(async () => {
    connected = false;
  });
  const specByPage = new Map<import("playwright-core").Page, MockPageSpec>();
  const pageActions = pages.map(() => ({
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));

  const pageObjects = pages.map((spec, index) => {
    const actions = pageActions[index]!;
    const page = {
      on: vi.fn(),
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
    browser: () => browser,
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
          return { targetInfo: { targetId: spec?.targetId } };
        }),
        detach: vi.fn(async () => {}),
      };
    }),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    isConnected: () => connected,
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
  return bundle;
}

afterEach(async () => {
  vi.useRealTimers();
  connectOverCdpSpy.mockReset();
  getChromeWebSocketEndpointSpy.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

beforeEach(() => {
  getChromeWebSocketEndpointSpy.mockResolvedValue(null);
});

describe("pw-session getPageForTargetId", () => {
  it("namespaces reused Lightpanda target IDs and refuses stale IDs without reconnecting", async () => {
    const endpoint = "ws://127.0.0.1:9222/";
    const first = installBrowser([{ targetId: "reused-target" }]);
    const [oldTab] = await listPagesViaPlaywright({ cdpUrl: endpoint, engine: "lightpanda" });
    if (!oldTab) {
      throw new Error("Missing first Lightpanda tab");
    }
    expect(oldTab.targetId).toMatch(/^connection:[^:]+:reused-target$/);
    expect(
      (await listPagesViaPlaywright({ cdpUrl: endpoint, engine: "lightpanda" }))[0]?.targetId,
    ).toBe(oldTab.targetId);
    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: oldTab.targetId })).resolves.toBe(
      first.pages[0],
    );

    await closePlaywrightBrowserConnection({ cdpUrl: endpoint });
    await expect(
      getPageForTargetId({ cdpUrl: endpoint, targetId: oldTab.targetId }),
    ).rejects.toThrow("Browser session was lost");
    expect(connectOverCdpSpy).toHaveBeenCalledOnce();

    const replacement = installBrowser([{ targetId: "reused-target" }]);
    const [newTab] = await listPagesViaPlaywright({ cdpUrl: endpoint, engine: "lightpanda" });
    if (!newTab) {
      throw new Error("Missing replacement Lightpanda tab");
    }
    expect(newTab.targetId).not.toBe(oldTab.targetId);
    await expect(
      getPageForTargetId({ cdpUrl: endpoint, targetId: oldTab.targetId }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: newTab.targetId })).resolves.toBe(
      replacement.pages[0],
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
  });

  it("stale Lightpanda page cleanup closes its captured browser, not the same-URL successor", async () => {
    const endpoint = "ws://127.0.0.1:9222/";
    const first = installBrowser([{ targetId: "reused-target" }]);
    await listPagesViaPlaywright({ cdpUrl: endpoint, engine: "lightpanda" });
    const retired = retirePlaywrightBrowserConnectionExact({ cdpUrl: endpoint });
    const replacement = installBrowser([{ targetId: "reused-target" }]);
    const [newTab] = await listPagesViaPlaywright({ cdpUrl: endpoint, engine: "lightpanda" });
    if (!newTab) {
      throw new Error("Missing replacement Lightpanda tab");
    }

    await closeConnectionScopedPageBrowser(endpoint, first.browser);

    expect(first.browserClose).toHaveBeenCalledOnce();
    expect(replacement.browserClose).not.toHaveBeenCalled();
    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: newTab.targetId })).resolves.toBe(
      replacement.pages[0],
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    await retired.close();
  });

  it("keeps no-target selection when Playwright cannot resolve target ids", async () => {
    const { pages } = installBrowser([{ targetLookupError: "Not allowed" }]);

    await expect(getPageForTargetId({ cdpUrl })).resolves.toBe(pages[0]);
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
          cdpUrl,
          targetId: "TARGET_B",
        }),
      ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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
      cdpUrl,
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
      cdpUrl,
      targetId: "TARGET_B",
    });
    await closePageByTargetIdViaPlaywright({
      cdpUrl,
      targetId: "TARGET_B",
    });

    expect(pageA?.bringToFront).not.toHaveBeenCalled();
    expect(pageA?.close).not.toHaveBeenCalled();
    expect(pageB?.bringToFront).toHaveBeenCalledTimes(1);
    expect(pageB?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a replacement connection when an older selection finishes after recovery", async () => {
    const endpoint = "http://127.0.0.1:9333";
    const lookupStarted = createDeferred<void>();
    const finishLookup = createDeferred<void>();
    const stalePage: MockPageSpec = { targetId: "OLD_TARGET" };
    const stale = makeBrowser([stalePage]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK" }]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    await getPageForTargetId({ cdpUrl: endpoint });

    stalePage.beforeTargetLookup = () => {
      lookupStarted.resolve();
      return finishLookup.promise;
    };
    const selection = getPageForTargetId({ cdpUrl: endpoint, targetId: "TARGET_OK" });
    await lookupStarted.promise;
    await closePlaywrightBrowserConnection({ cdpUrl: endpoint });
    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: "TARGET_OK" })).resolves.toBe(
      fresh.pages[0],
    );
    finishLookup.resolve();

    await expect(selection).resolves.toBe(fresh.pages[0]);
    expect(fresh.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves blocked targets when reconnecting after a stale selection", async () => {
    const endpoint = "http://127.0.0.1:9333";
    const stale = makeBrowser([{ targetId: "OLD_TARGET" }]);
    const fresh = makeBrowser([{ targetId: "BLOCKED" }, { targetId: "HEALTHY" }]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    await getPageForTargetId({ cdpUrl: endpoint });
    markTargetBlocked(endpoint, "BLOCKED");

    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: "HEALTHY" })).resolves.toBe(
      fresh.pages[1],
    );
    await expect(getPageForTargetId({ cdpUrl: endpoint })).resolves.toBe(fresh.pages[1]);
    await expect(getPageForTargetId({ cdpUrl: endpoint, targetId: "BLOCKED" })).rejects.toThrow(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    await expect(
      getPageForTargetId({ cdpUrl: endpoint, targetId: "MISSING_TARGET" }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await expect(getPageForTargetId({ cdpUrl: endpoint })).resolves.toBe(fresh.pages[1]);
  });
});
