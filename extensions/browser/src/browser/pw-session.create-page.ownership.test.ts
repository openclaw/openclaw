import type { Browser, BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, pwAi } = setupPwSessionConnectionTest();
const { createPageViaPlaywright } = pwAi;

function installBrowserMocks() {
  const openPages: Page[] = [];
  const pageGoto = vi.fn(async () => null);
  const pageRoute = vi.fn();
  const pageFocus = vi.fn(async () => {});
  const pageClose = vi.fn(async () => {
    openPages.splice(openPages.indexOf(page), 1);
  });
  const sessionSend = vi.fn(async (_method: string) => ({
    targetInfo: { targetId: "TARGET_1", title: "" },
  }));
  const page = {
    on: vi.fn(),
    context: () => context,
    goto: pageGoto,
    close: pageClose,
    title: async () => "",
    url: () => "about:blank",
    route: pageRoute,
    bringToFront: pageFocus,
    unroute: vi.fn(),
  } as unknown as Page;
  const contextClose = vi.fn(async () => {
    openPages.length = 0;
  });
  const newPage = vi.fn(async () => {
    openPages.push(page);
    return page;
  });
  const context = {
    on: vi.fn(),
    pages: () => openPages,
    browser: () => browser,
    newPage,
    close: contextClose,
    newCDPSession: async () => ({ send: sessionSend, detach: async () => {} }),
  } as unknown as BrowserContext;
  const newContext = vi.fn(async () => context);
  const browserClose = vi.fn();
  const browser = {
    newContext,
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as Browser;
  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return {
    browser,
    browserClose,
    context,
    page,
    pageGoto,
    pageRoute,
    pageFocus,
    pageClose,
    sessionSend,
    contextClose,
    newContext,
    newPage,
  };
}

describe("Playwright created-page ownership", () => {
  it("closes the captured Lightpanda connection when its created page is released", async () => {
    const fixture = installBrowserMocks();
    const created = await createPageViaPlaywright({
      cdpUrl: "ws://127.0.0.1:18792/",
      engine: "lightpanda",
      url: "about:blank",
    });
    expect(created.targetId).toMatch(/^connection:[^:]+:TARGET_1$/);
    expect(fixture.newContext).not.toHaveBeenCalled();
    await created.close();
    expect(fixture.browserClose).toHaveBeenCalledOnce();
    expect(fixture.pageClose).not.toHaveBeenCalled();
    expect(fixture.contextClose).not.toHaveBeenCalled();
  });

  it("refuses a second Lightpanda page without closing the existing page or connection", async () => {
    const fixture = installBrowserMocks();
    await fixture.newPage();
    fixture.newPage.mockClear();
    await expect(
      createPageViaPlaywright({
        cdpUrl: "ws://127.0.0.1:18792/",
        engine: "lightpanda",
        url: "about:blank",
      }),
    ).rejects.toThrow("Lightpanda supports 1 page per connection");
    expect(fixture.newContext).not.toHaveBeenCalled();
    expect(fixture.newPage).not.toHaveBeenCalled();
    expect(fixture.browserClose).not.toHaveBeenCalled();
    expect(fixture.pageClose).not.toHaveBeenCalled();
    expect(fixture.context.pages()).toEqual([fixture.page]);
  });

  it.each(["connect", "context", "page", "target", "route"] as const)(
    "rejects an unsignalled authority revocation during %s before navigation",
    async (stage) => {
      const fixture = installBrowserMocks();
      getChromeWebSocketUrlSpy.mockResolvedValue({
        url: "ws://127.0.0.1:18792/devtools/browser/authority-fixture",
      });
      let started!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const pause = async <T>(result: T) => {
        started();
        await pending;
        return result;
      };
      if (stage === "connect") {
        connectOverCdpSpy.mockImplementationOnce(() => pause(fixture.browser));
      } else if (stage === "context") {
        fixture.newContext.mockImplementationOnce(() => pause(fixture.context));
      } else if (stage === "page") {
        fixture.newPage.mockImplementationOnce(() => pause(fixture.page));
      } else if (stage === "target") {
        fixture.sessionSend.mockImplementationOnce(() =>
          pause({ targetInfo: { targetId: "TARGET_1", title: "" } }),
        );
      } else {
        fixture.pageRoute.mockImplementationOnce(async () => {
          await pause(undefined);
        });
      }
      let current = true;
      const creation = createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "http://127.0.0.1:18793/revocation-fixture",
        isolatedContext: true,
        ssrfPolicy: { allowPrivateNetwork: true },
        assertCurrent: () => {
          if (!current) {
            throw new Error("caller receipt expired");
          }
        },
      });
      try {
        await Promise.race([
          entered,
          creation.then(() => {
            throw new Error(`Creation completed before the ${stage} rendezvous`);
          }),
        ]);
        current = false;
        resume();
        await expect(creation).rejects.toThrow("caller receipt expired");
      } finally {
        resume();
        await creation.catch(() => {});
      }
      expect(fixture.pageGoto).not.toHaveBeenCalled();
      expect(fixture.newContext).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
      expect(fixture.contextClose).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
    },
  );

  it("starts navigation in the same turn as its synchronous authority assertion", async () => {
    const { gotoPageWithNavigationGuard } = await import("./pw-session-navigation.js");
    const fixture = installBrowserMocks();
    let expired = false;
    fixture.pageGoto.mockImplementationOnce(async () => {
      expect(expired).toBe(false);
      return null;
    });
    await gotoPageWithNavigationGuard({
      cdpUrl: "http://127.0.0.1:18792",
      page: fixture.page,
      url: "http://127.0.0.1:18793/authority-turn",
      timeoutMs: 1000,
      assertPageCurrent: () => {
        queueMicrotask(() => {
          expired = true;
        });
      },
    });
    expect(fixture.pageGoto).toHaveBeenCalledOnce();
    expect(expired).toBe(true);
  });

  it("closes a new page when its target identity cannot be read", async () => {
    const { page, pageClose, sessionSend } = installBrowserMocks();
    sessionSend.mockRejectedValue(new Error("Target metadata unavailable"));

    await expect(
      createPageViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", url: "about:blank" }),
    ).rejects.toThrow("Failed to get targetId for new page");

    expect(pageClose).toHaveBeenCalledOnce();
    expect(page.context().pages()).toEqual([]);
  });

  it("focuses an existing page in the same turn as its synchronous authority assertion", async () => {
    const fixture = installBrowserMocks();
    await fixture.newPage();
    let expired = false;
    fixture.pageFocus.mockImplementationOnce(async () => {
      expect(expired).toBe(false);
    });
    await pwAi.focusPageByTargetIdViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_1",
      assertCurrent: () => {
        queueMicrotask(() => {
          expired = true;
        });
      },
    });
    expect(fixture.pageFocus).toHaveBeenCalledOnce();
    expect(expired).toBe(true);
  });

  it("does not navigate when cancellation wins navigation validation", async () => {
    const { pageGoto, page } = installBrowserMocks();
    let started!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const validationPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validation = vi
      .spyOn(await import("./navigation-guard.js"), "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => {
        started();
        await validationPending;
      });
    const controller = new AbortController();
    try {
      const creation = createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com",
        signal: controller.signal,
      });
      const rejected = expect(creation).rejects.toThrow("cancelled validation");
      await validationStarted;
      controller.abort(new Error("cancelled validation"));
      release();
      await rejected;

      expect(pageGoto).not.toHaveBeenCalled();
      expect(page.context().pages()).toEqual([]);
    } finally {
      release();
      validation.mockRestore();
    }
  });

  it("closes a new page when cancellation wins target resolution", async () => {
    const { pageClose, sessionSend } = installBrowserMocks();
    let releaseTargetInfo: (() => void) | undefined;
    let markTargetInfoStarted: (() => void) | undefined;
    const targetInfoStarted = new Promise<void>((resolve) => {
      markTargetInfoStarted = resolve;
    });
    const targetInfoReleased = new Promise<void>((resolve) => {
      releaseTargetInfo = resolve;
    });
    sessionSend.mockImplementationOnce(async () => {
      markTargetInfoStarted?.();
      await targetInfoReleased;
      return { targetInfo: { targetId: "TARGET_1", title: "" } };
    });
    const controller = new AbortController();

    const creation = createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
      signal: controller.signal,
    });
    await targetInfoStarted;
    controller.abort(new Error("cancelled page creation"));
    releaseTargetInfo?.();

    await expect(creation).rejects.toThrow("cancelled page creation");
    expect(pageClose).toHaveBeenCalledOnce();
  });
});
