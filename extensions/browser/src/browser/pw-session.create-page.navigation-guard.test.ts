import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as navigationGuardModule from "./navigation-guard.js";
import {
  BlockedBrowserTargetError,
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  listPagesViaPlaywright,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function installBrowserMocks() {
  const pageOn = vi.fn();
  let routeHandler:
    | ((
        route: { continue: () => Promise<void>; abort: () => Promise<void> },
        request: unknown,
      ) => Promise<void>)
    | null = null;
  const pageGoto = vi.fn<
    (...args: unknown[]) => Promise<null | { request: () => Record<string, unknown> }>
  >(async () => null);
  const pageTitle = vi.fn(async () => "");
  const pageUrl = vi.fn(() => "about:blank");
  const pageRoute = vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
    routeHandler = handler;
  });
  const pageUnroute = vi.fn(async () => {
    routeHandler = null;
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

afterEach(async () => {
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

  it("blocks private intermediate redirect hops", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
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
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        {
          continue: vi.fn(async () => {
            throw new Error("page.goto: Frame has been detached");
          }),
          abort: vi.fn(async () => {}),
        },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://example.com",
        },
      );
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

  it("propagates unsupported redirect protocols as navigation errors", async () => {
    const { pageGoto, pageClose, getRouteHandler, mainFrame } = installBrowserMocks();
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "file:///etc/passwd",
        },
      );
      throw new Error("Navigation aborted");
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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/start",
        },
      );
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
      throw new Error("Navigation aborted");
    });

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
      targetId: "MISSING_TARGET",
    });

    pageGoto.mockImplementationOnce(async () => {
      const handler = getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
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
      const handler = first.getRouteHandler();
      if (!handler) {
        throw new Error("missing route handler");
      }
      await handler(
        { continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
        {
          isNavigationRequest: () => true,
          frame: () => first.mainFrame,
          url: () => "http://127.0.0.1:18080/internal-hop",
        },
      );
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
