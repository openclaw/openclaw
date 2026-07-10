// Browser tests cover pw session.create page.navigation guard plugin behavior.
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import "../test-support/browser-security.mock.js";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as navigationGuardModule from "./navigation-guard.js";
import {
  BlockedBrowserTargetError,
  classifyBrowserDocumentNavigationRequest,
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  listPagesViaPlaywright,
  wasBrowserNavigationRequestBlockedBeforeDispatch,
  withPageNavigationRequestGuard,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

type MockRoute = {
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
  abort: () => Promise<void>;
};
type MockRequest = {
  isNavigationRequest: () => boolean;
  frame: () => object;
  resourceType?: () => string;
  url: () => string;
};
type MockRouteHandler = (route: MockRoute, request: MockRequest) => Promise<void>;

function installBrowserMocks() {
  const pageOn = vi.fn();
  let routeHandler: MockRouteHandler | null = null;
  const pageGoto = vi.fn<
    (...args: unknown[]) => Promise<null | { request: () => Record<string, unknown> }>
  >(async () => null);
  const pageTitle = vi.fn(async () => "");
  const pageUrl = vi.fn(() => "about:blank");
  const pageRoute = vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
    routeHandler = handler;
  });
  const pageUnroute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
    if (routeHandler === handler) {
      routeHandler = null;
    }
  });
  const openPages: import("playwright-core").Page[] = [];
  const pageClose = vi.fn(async () => {
    const index = openPages.indexOf(page);
    if (index >= 0) {
      openPages.splice(index, 1);
    }
  });
  const mainFrame = {};
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const sessionSend = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    return {};
  });
  const sessionDetach = vi.fn(async () => {});

  const context = {
    pages: () => openPages,
    on: contextOn,
    newPage: vi.fn(async () => {
      openPages.push(page);
      return page;
    }),
    newCDPSession: vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const page = {
    on: pageOn,
    context: () => context,
    goto: pageGoto,
    title: pageTitle,
    url: pageUrl,
    route: pageRoute,
    unroute: pageUnroute,
    close: pageClose,
    mainFrame: () => mainFrame,
  } as unknown as import("playwright-core").Page;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);

  const getBrowserDisconnectedHandler = () =>
    browserOn.mock.calls.find((call) => call[0] === "disconnected")?.[1] as
      | (() => void)
      | undefined;

  return {
    pageGoto,
    page,
    pageRoute,
    pageUnroute,
    browserClose,
    pageClose,
    sessionSend,
    getBrowserDisconnectedHandler,
    getRouteHandler: () => routeHandler,
    mainFrame,
    pushOpenPage: () => {
      openPages.push(page);
      return page;
    },
  };
}

function createMockRoute(route?: Partial<MockRoute>): MockRoute {
  return {
    continue: vi.fn(async () => {}),
    fallback: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...route,
  };
}

async function dispatchMockNavigation(params: {
  getRouteHandler: () => MockRouteHandler | null;
  mainFrame: object;
  url: string;
  frame?: object;
  isNavigationRequest?: boolean;
  resourceType?: string;
  route?: Partial<MockRoute>;
}) {
  const handler = params.getRouteHandler();
  if (!handler) {
    throw new Error("missing route handler");
  }
  const { resourceType } = params;
  await handler(createMockRoute(params.route), {
    isNavigationRequest: () => params.isNavigationRequest ?? true,
    frame: () => params.frame ?? params.mainFrame,
    ...(resourceType ? { resourceType: () => resourceType } : {}),
    url: () => params.url,
  });
}

function mockBlockedRedirectNavigation(params: {
  pageGoto: ReturnType<typeof installBrowserMocks>["pageGoto"];
  getRouteHandler: () => MockRouteHandler | null;
  mainFrame: object;
  startUrl?: string;
  hopUrl?: string;
  hopIsNavigationRequest?: boolean;
  hopResourceType?: string;
}) {
  params.pageGoto.mockImplementationOnce(async () => {
    await dispatchMockNavigation({
      getRouteHandler: params.getRouteHandler,
      mainFrame: params.mainFrame,
      url: params.startUrl ?? "https://93.184.216.34/start",
    });
    await dispatchMockNavigation({
      getRouteHandler: params.getRouteHandler,
      mainFrame: params.mainFrame,
      url: params.hopUrl ?? "http://127.0.0.1:18080/internal-hop",
      isNavigationRequest: params.hopIsNavigationRequest,
      resourceType: params.hopResourceType,
    });
    throw new Error("Navigation aborted");
  });
}

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session createPageViaPlaywright navigation guard", () => {
  it("blocks unsupported non-network URLs", async () => {
    const { pageGoto } = installBrowserMocks();

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("allows about:blank without network navigation", async () => {
    const { pageGoto } = installBrowserMocks();

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("blocks hostname navigation when strict SSRF policy is configured", async () => {
    const { pageGoto } = installBrowserMocks();

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("blocks private intermediate redirect hops", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("blocks private redirect hops even when Playwright marks hop as non-navigation", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({
      pageGoto,
      getRouteHandler,
      mainFrame,
      hopIsNavigationRequest: false,
      hopResourceType: "document",
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("aborts private subframe document hops without quarantining the page", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const subframe = {};
    const subframeRoute = createMockRoute();
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://93.184.216.34/start",
      });
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        frame: subframe,
        url: "http://127.0.0.1:18080/internal-hop",
        route: subframeRoute,
      });
      return {
        request: () => ({
          url: () => "https://93.184.216.34/start",
          redirectedFrom: () => null,
        }),
      };
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://93.184.216.34/start",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(subframeRoute.abort).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("preserves the created tab on ordinary navigation failure", async () => {
    const { pageGoto, pageClose } = installBrowserMocks();
    pageGoto.mockRejectedValueOnce(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"));

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://93.184.216.34/start",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(created.url).toBe("about:blank");
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("does not quarantine a tab when route.continue fails", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://example.com",
        route: {
          continue: vi.fn(async () => {
            throw new Error("page.goto: Frame has been detached");
          }),
        },
      });
      throw new Error("page.goto: Frame has been detached");
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("ignores already-handled route races during guarded navigation", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const route = createMockRoute({
      continue: vi.fn(async () => {
        throw new Error("Route is already handled");
      }),
    });
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://example.com",
        route,
      });
      return null;
    });

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();
  });

  it("propagates unsupported redirect protocols as navigation errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    mockBlockedRedirectNavigation({
      pageGoto,
      getRouteHandler,
      mainFrame,
      hopUrl: "file:///etc/passwd",
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).toHaveBeenCalledTimes(1);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("does not quarantine a tab on transient redirect lookup errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const assertNavigationAllowedSpy = vi.spyOn(
      navigationGuardModule,
      "assertBrowserNavigationAllowed",
    );
    assertNavigationAllowedSpy.mockImplementation(async (opts: { url: string }) => {
      if (opts.url === "http://127.0.0.1:18080/internal-hop") {
        throw new Error("getaddrinfo EAI_AGAIN internal-hop");
      }
    });
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    try {
      const created = await createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      });
      const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });

      expect(created.targetId).toBe("TARGET_1");
      expect(pages).toHaveLength(1);
      expect(pageClose).not.toHaveBeenCalled();
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }
  });

  it("does not quarantine a tab on transient post-navigation check errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    const assertRedirectChainAllowedSpy = vi.spyOn(
      navigationGuardModule,
      "assertBrowserNavigationRedirectChainAllowed",
    );
    assertRedirectChainAllowedSpy.mockRejectedValueOnce(
      new Error("getaddrinfo EAI_AGAIN postcheck.example"),
    );
    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "https://93.184.216.34/start",
      });
      return {
        request: () => ({
          url: () => "https://93.184.216.34/final",
          redirectedFrom: () => ({
            url: () => "https://postcheck.example/hop",
            redirectedFrom: () => null,
          }),
        }),
      };
    });

    try {
      await expect(
        createPageViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          url: "https://93.184.216.34/start",
        }),
      ).rejects.toThrow(/getaddrinfo .*postcheck\.example/);

      const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });
      expect(pages).toHaveLength(1);
      expect(pages[0]?.targetId).toBe("TARGET_1");
      expect(pageClose).not.toHaveBeenCalled();
    } finally {
      assertRedirectChainAllowedSpy.mockRestore();
    }
  });

  it("keeps blocked tab quarantined if close fails", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });
    expect(pages).toHaveLength(0);
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
    expect(pageClose).toHaveBeenCalledTimes(1);
  });

  it("preserves blocked-target quarantine across forced reconnects", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:18792",
      reason: "test forced reconnect",
    });

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
  });

  it("preserves blocked-target quarantine across transport disconnects", async () => {
    const { pageGoto, pageClose, getBrowserDisconnectedHandler, getRouteHandler, mainFrame } =
      installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    const disconnectedHandler = getBrowserDisconnectedHandler();
    expect(disconnectedHandler).toBeTypeOf("function");
    disconnectedHandler?.();

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
  });

  it("keeps blocked tabs inaccessible when target lookup fails", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));
    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
  });

  it("does not fall back to another tab when explicit target lookup misses", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));
    mockBlockedRedirectNavigation({ pageGoto, getRouteHandler, mainFrame });

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    sessionSend.mockImplementationOnce(async (method: string) => {
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "TARGET_2" } };
      }
      return {};
    });
    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
    });

    let targetInfoLookups = 0;
    sessionSend.mockImplementation(async (method: string) => {
      if (method === "Target.getTargetInfo") {
        targetInfoLookups += 1;
        return {
          targetInfo: { targetId: targetInfoLookups % 2 === 1 ? "TARGET_1" : "TARGET_2" },
        };
      }
      return {};
    });

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "MISSING_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
  });

  it("quarantines the actual page when blocked navigation receives a stale target id", async () => {
    const { pageGoto, pageClose, sessionSend, getRouteHandler, mainFrame } = installBrowserMocks();
    pageClose.mockRejectedValueOnce(new Error("close failed"));

    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });

    const page = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
    });

    pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler,
        mainFrame,
        url: "http://127.0.0.1:18080/internal-hop",
      });
      throw new Error("Navigation aborted");
    });

    // Simulate target-info churn while quarantining so caller target id cannot be trusted.
    sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));

    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        url: "https://93.184.216.34/start",
        timeoutMs: 1000,
        targetId: "MISSING_TARGET",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
  });

  it("falls back to caller targetId quarantine when target lookup fails", async () => {
    const first = installBrowserMocks();
    first.pageClose.mockRejectedValueOnce(new Error("close failed"));

    await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });
    const page = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_1",
    });

    first.pageGoto.mockImplementationOnce(async () => {
      await dispatchMockNavigation({
        getRouteHandler: first.getRouteHandler,
        mainFrame: first.mainFrame,
        url: "http://127.0.0.1:18080/internal-hop",
      });
      throw new Error("Navigation aborted");
    });

    first.sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));
    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        url: "https://93.184.216.34/start",
        timeoutMs: 1000,
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:18792",
      reason: "test reconnect after blocked navigation",
    });

    const second = installBrowserMocks();
    second.pushOpenPage();

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_1",
      }),
    ).rejects.toBeInstanceOf(BlockedBrowserTargetError);
  });
});

describe("pw-session page-scoped interaction request guard", () => {
  const strictPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

  it("classifies top-level, subframe, and non-document requests", () => {
    const { mainFrame, page } = installBrowserMocks();
    const topLevelDocument = {
      frame: () => mainFrame,
      isNavigationRequest: () => false,
      resourceType: () => "document",
    };
    const subframeDocument = {
      frame: () => ({}),
      isNavigationRequest: () => true,
      resourceType: () => "document",
    };
    const image = {
      frame: () => mainFrame,
      isNavigationRequest: () => false,
      resourceType: () => "image",
    };
    const unresolvedFrame = {
      frame: () => {
        throw new Error("frame detached");
      },
      isNavigationRequest: () => {
        throw new Error("request detached");
      },
      resourceType: () => {
        throw new Error("request detached");
      },
    };

    expect(classifyBrowserDocumentNavigationRequest(page, topLevelDocument as never)).toBe(
      "top-level",
    );
    expect(classifyBrowserDocumentNavigationRequest(page, subframeDocument as never)).toBe(
      "subframe",
    );
    expect(classifyBrowserDocumentNavigationRequest(page, image as never)).toBeNull();
    expect(classifyBrowserDocumentNavigationRequest(page, unresolvedFrame as never)).toBe(
      "subframe",
    );
  });

  it("preserves no-policy callers without installing a page route", async () => {
    const { page, pageRoute, pageUnroute } = installBrowserMocks();

    await expect(
      withPageNavigationRequestGuard({
        page,
        action: async () => "ok",
      }),
    ).resolves.toBe("ok");

    expect(pageRoute).not.toHaveBeenCalled();
    expect(pageUnroute).not.toHaveBeenCalled();
  });

  it("treats direct proxy mode alone as no policy", async () => {
    const { page, pageRoute, pageUnroute } = installBrowserMocks();

    await expect(
      withPageNavigationRequestGuard({
        page,
        browserProxyMode: "direct",
        action: async () => "ok",
      }),
    ).resolves.toBe("ok");

    expect(pageRoute).not.toHaveBeenCalled();
    expect(pageUnroute).not.toHaveBeenCalled();
  });

  it("fails closed for explicit browser proxy mode without an SSRF policy", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const blocked = new InvalidBrowserNavigationUrlError("proxy-routed navigation blocked");
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockRejectedValueOnce(blocked);
    const route = createMockRoute();

    try {
      await expect(
        withPageNavigationRequestGuard({
          page,
          browserProxyMode: "explicit-browser-proxy",
          action: async () => {
            await dispatchMockNavigation({
              getRouteHandler,
              mainFrame,
              url: "https://example.com/private-via-proxy",
              route,
            });
          },
        }),
      ).rejects.toBe(blocked);
      expect(route.abort).toHaveBeenCalledTimes(1);
      expect(wasBrowserNavigationRequestBlockedBeforeDispatch(blocked)).toBe(true);
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }
  });

  it("falls through allowed documents and non-document requests, then removes its exact route", async () => {
    const { getRouteHandler, mainFrame, page, pageRoute, pageUnroute } = installBrowserMocks();
    const allowedDocument = createMockRoute();
    const image = createMockRoute();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/page",
            route: allowedDocument,
          });
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1/secret.png",
            isNavigationRequest: false,
            resourceType: "image",
            route: image,
          });
          return "ok";
        },
      }),
    ).resolves.toBe("ok");

    expect(allowedDocument.fallback).toHaveBeenCalledTimes(1);
    expect(image.fallback).toHaveBeenCalledTimes(1);
    expect(allowedDocument.continue).not.toHaveBeenCalled();
    expect(image.continue).not.toHaveBeenCalled();
    const handler = pageRoute.mock.calls[0]?.[1];
    expect(pageRoute).toHaveBeenCalledWith("**", handler);
    expect(pageUnroute).toHaveBeenCalledWith("**", handler);
  });

  it.each([
    { name: "top-level", subframe: false },
    { name: "subframe", subframe: true },
  ])(
    "aborts a blocked $name document and returns policy denial ahead of the action error",
    async ({ subframe }) => {
      const { getRouteHandler, mainFrame, page } = installBrowserMocks();
      const route = createMockRoute();
      let caught: unknown;

      try {
        await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: strictPolicy,
          action: async () => {
            await dispatchMockNavigation({
              getRouteHandler,
              mainFrame,
              frame: subframe ? {} : mainFrame,
              url: "http://127.0.0.1:18080/private",
              route,
            });
            throw new Error("locator detached");
          },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SsrFBlockedError);
      expect(route.abort).toHaveBeenCalledTimes(1);
      expect(route.fallback).not.toHaveBeenCalled();
      expect(wasBrowserNavigationRequestBlockedBeforeDispatch(caught)).toBe(true);
    },
  );

  it("waits for an in-flight policy check before completing and cleaning up", async () => {
    const { getRouteHandler, mainFrame, page, pageUnroute } = installBrowserMocks();
    let releasePolicy!: () => void;
    const policyPending = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => await policyPending);
    const route = createMockRoute();
    let settled = false;
    let dispatched: Promise<void> | undefined;

    try {
      const guarded = withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          dispatched = dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/page",
            route,
          });
          return "ok";
        },
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => expect(assertNavigationAllowedSpy).toHaveBeenCalledTimes(1));
      expect(pageUnroute).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      releasePolicy();
      await expect(guarded).resolves.toBe("ok");
      await dispatched;
      expect(route.fallback).toHaveBeenCalledTimes(1);
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }
  });

  it("does not claim pre-dispatch prevention when route.abort fails", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const route = createMockRoute({
      abort: vi.fn(async () => {
        throw new Error("Route is already handled");
      }),
    });
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/private",
            route,
          });
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SsrFBlockedError);
    expect(wasBrowserNavigationRequestBlockedBeforeDispatch(caught)).toBe(false);
  });

  it("keeps the first concurrent policy error stable and aborts every denied route", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const firstError = new InvalidBrowserNavigationUrlError("first denial");
    const secondError = new InvalidBrowserNavigationUrlError("second denial");
    let rejectSecond!: (error: Error) => void;
    const secondCheck = new Promise<never>((_, reject) => {
      rejectSecond = reject;
    });
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockRejectedValueOnce(firstError)
      .mockImplementationOnce(async () => await secondCheck);
    const firstRoute = createMockRoute();
    const secondRoute = createMockRoute();
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          const first = dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/first",
            route: firstRoute,
          });
          const second = dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "http://127.0.0.1:18080/second",
            route: secondRoute,
          });
          await first;
          rejectSecond(secondError);
          await second;
        },
      });
    } catch (err) {
      caught = err;
    } finally {
      assertNavigationAllowedSpy.mockRestore();
    }

    expect(caught).toBe(firstError);
    expect(firstRoute.abort).toHaveBeenCalledTimes(1);
    expect(secondRoute.abort).toHaveBeenCalledTimes(1);
    expect(wasBrowserNavigationRequestBlockedBeforeDispatch(caught)).toBe(true);
  });

  it("leaves a concurrent denial unmarked when any denied route cannot abort", async () => {
    const { getRouteHandler, mainFrame, page } = installBrowserMocks();
    const firstRoute = createMockRoute();
    const failedRoute = createMockRoute({
      abort: vi.fn(async () => {
        throw new Error("Route is already handled");
      }),
    });
    let caught: unknown;

    try {
      await withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          await Promise.all([
            dispatchMockNavigation({
              getRouteHandler,
              mainFrame,
              url: "http://127.0.0.1:18080/first",
              route: firstRoute,
            }),
            dispatchMockNavigation({
              getRouteHandler,
              mainFrame,
              url: "http://127.0.0.1:18080/second",
              route: failedRoute,
            }),
          ]);
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SsrFBlockedError);
    expect(firstRoute.abort).toHaveBeenCalledTimes(1);
    expect(failedRoute.abort).toHaveBeenCalledTimes(1);
    expect(wasBrowserNavigationRequestBlockedBeforeDispatch(caught)).toBe(false);
  });

  it("removes its exact route when the action fails before any request", async () => {
    const { page, pageRoute, pageUnroute } = installBrowserMocks();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          throw new Error("locator failed");
        },
      }),
    ).rejects.toThrow("locator failed");

    const handler = pageRoute.mock.calls[0]?.[1];
    expect(pageUnroute).toHaveBeenCalledWith("**", handler);
  });

  it("rolls back its exact handler when route setup rejects", async () => {
    const { getRouteHandler, page, pageRoute, pageUnroute } = installBrowserMocks();
    const installRoute = pageRoute.getMockImplementation();
    const setupError = new Error("route setup failed");
    pageRoute.mockImplementationOnce(async (...args) => {
      await installRoute?.(...args);
      throw setupError;
    });
    const action = vi.fn(async () => "unreachable");

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action,
      }),
    ).rejects.toBe(setupError);

    const handler = pageRoute.mock.calls[0]?.[1];
    expect(pageUnroute).toHaveBeenCalledWith("**", handler);
    expect(getRouteHandler()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("ignores exact-route cleanup failure after the action closes its page", async () => {
    const { page, pageUnroute } = installBrowserMocks();
    let closed = false;
    Object.assign(page, { isClosed: () => closed });
    pageUnroute.mockRejectedValueOnce(new Error("Target page has been closed"));

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => {
          closed = true;
          return "closed";
        },
      }),
    ).resolves.toBe("closed");
  });

  it("surfaces exact-route cleanup failure while the page remains open", async () => {
    const { page, pageUnroute } = installBrowserMocks();
    Object.assign(page, { isClosed: () => false });
    const cleanupError = new Error("route cleanup failed");
    pageUnroute.mockRejectedValueOnce(cleanupError);

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        action: async () => "ok",
      }),
    ).rejects.toBe(cleanupError);
  });
});
