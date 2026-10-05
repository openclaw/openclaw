import type { Browser, BrowserContext, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, pwAi } = setupPwSessionConnectionTest();
const { createPageViaPlaywright } = pwAi;
const cdpUrl = "http://127.0.0.1:18792";
const lightpanda = { cdpUrl: "ws://127.0.0.1:18792/", engine: "lightpanda" } as const;
const targetInfo = { targetInfo: { targetId: "TARGET_1", title: "" } };

function installBrowserMocks() {
  const openPages: Page[] = [];
  const sessionSend = vi.fn(async (_method: string) => targetInfo);
  const pageMock = {
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    isClosed: () => false,
    context: () => context,
    goto: vi.fn(async () => null),
    close: vi.fn(async () => {
      openPages.splice(openPages.indexOf(page), 1);
    }),
    title: async () => "",
    url: () => "about:blank",
    route: vi.fn(),
    bringToFront: vi.fn(async () => {}),
    unroute: vi.fn(),
  };
  const page = pageMock as unknown as Page;
  const contextMock = {
    on: vi.fn(),
    pages: () => openPages,
    browser: () => browser,
    newPage: vi.fn(async () => {
      openPages.push(page);
      return page;
    }),
    close: vi.fn(async () => {
      openPages.length = 0;
    }),
    newCDPSession: async () => ({
      send: sessionSend,
      detach: async () => {},
      on: vi.fn(),
      off: vi.fn(),
    }),
  };
  const context = contextMock as unknown as BrowserContext;
  const browserMock = {
    newContext: vi.fn(async () => context),
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  };
  const browser = browserMock as unknown as Browser;
  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return { browser, context, page, browserMock, contextMock, pageMock, sessionSend };
}
let f: ReturnType<typeof installBrowserMocks>;
beforeEach(() => {
  f = installBrowserMocks();
});
function create(opts: Partial<Parameters<typeof createPageViaPlaywright>[0]> = {}) {
  return createPageViaPlaywright({ cdpUrl, url: "about:blank", ...opts });
}
function pauseAtBoundary() {
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: pending.resolve,
    pause: async <T>(result: T) => {
      entered.resolve();
      await pending.promise;
      return result;
    },
  };
}

describe("Playwright created-page ownership", () => {
  it("closes the captured Lightpanda connection when its created page is released", async () => {
    const created = await create(lightpanda);
    expect(created.targetId).toMatch(/^connection:[^:]+:TARGET_1$/);
    expect(f.browserMock.newContext).not.toHaveBeenCalled();
    await created.close();
    expect(f.browserMock.close).toHaveBeenCalledOnce();
    expect(f.pageMock.close).not.toHaveBeenCalled();
    expect(f.contextMock.close).not.toHaveBeenCalled();
  });
  it("refuses a second Lightpanda page without closing the existing page or connection", async () => {
    await f.contextMock.newPage();
    f.contextMock.newPage.mockClear();
    await expect(create(lightpanda)).rejects.toThrow("Lightpanda supports 1 page per connection");
    expect(f.browserMock.newContext).not.toHaveBeenCalled();
    expect(f.contextMock.newPage).not.toHaveBeenCalled();
    expect(f.browserMock.close).not.toHaveBeenCalled();
    expect(f.pageMock.close).not.toHaveBeenCalled();
    expect(f.context.pages()).toEqual([f.page]);
  });
  it.each(["connect", "context", "page", "target", "route"] as const)(
    "rejects an unsignalled authority revocation during %s before navigation",
    async (stage) => {
      getChromeWebSocketUrlSpy.mockResolvedValue({
        url: "ws://127.0.0.1:18792/devtools/browser/authority-fixture",
      });
      const { entered, release, pause } = pauseAtBoundary();
      if (stage === "connect") {
        connectOverCdpSpy.mockImplementationOnce(() => pause(f.browser));
      } else if (stage === "context") {
        f.browserMock.newContext.mockImplementationOnce(() => pause(f.context));
      } else if (stage === "page") {
        f.contextMock.newPage.mockImplementationOnce(() => pause(f.page));
      } else if (stage === "target") {
        f.sessionSend.mockImplementationOnce(() => pause(targetInfo));
      } else {
        f.pageMock.route.mockImplementationOnce(() => pause(undefined));
      }
      let current = true;
      const creation = create({
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
        release();
        await expect(creation).rejects.toThrow("caller receipt expired");
      } finally {
        release();
        await creation.catch(() => {});
      }
      expect(f.pageMock.goto).not.toHaveBeenCalled();
      expect(f.browserMock.newContext).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
      expect(f.contextMock.close).toHaveBeenCalledTimes(stage === "connect" ? 0 : 1);
    },
  );
  it("rechecks a scoped navigation grant after awaited route installation", async () => {
    getChromeWebSocketUrlSpy.mockResolvedValue({
      url: "ws://127.0.0.1:18792/devtools/browser/authority-fixture",
    });
    const { entered, release, pause } = pauseAtBoundary();
    f.pageMock.route.mockImplementationOnce(() => pause(undefined));
    let current = true;
    const creation = create({
      url: "http://127.0.0.1:18793/preview",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      assertNavigationCurrent: () => {
        if (!current) {
          throw new Error("preview invocation revoked");
        }
      },
    });
    const rejected = expect(creation).rejects.toThrow("preview invocation revoked");
    try {
      await Promise.race([
        entered,
        creation.then(() => {
          throw new Error("Creation completed before route installation");
        }),
      ]);
      current = false;
      release();
      await rejected;
      expect(f.pageMock.goto).not.toHaveBeenCalled();
      expect(f.pageMock.close).toHaveBeenCalledOnce();
    } finally {
      release();
      await creation.catch(() => {});
    }
  });
  it("starts navigation in the same turn as its synchronous authority assertion", async () => {
    const { gotoPageWithNavigationGuard } = await import("./pw-session-navigation.js");
    let expired = false;
    f.pageMock.goto.mockImplementationOnce(async () => {
      expect(expired).toBe(false);
      return null;
    });
    await gotoPageWithNavigationGuard({
      cdpUrl,
      page: f.page,
      url: "http://127.0.0.1:18793/authority-turn",
      timeoutMs: 1000,
      assertPageCurrent: () => {
        queueMicrotask(() => {
          expired = true;
        });
      },
    });
    expect(f.pageMock.goto).toHaveBeenCalledOnce();
    expect(expired).toBe(true);
  });
  it("closes a new page when its target identity cannot be read", async () => {
    f.sessionSend.mockRejectedValue(new Error("Target metadata unavailable"));
    await expect(create()).rejects.toThrow("Failed to get targetId for new page");
    expect(f.pageMock.close).toHaveBeenCalledOnce();
    expect(f.page.context().pages()).toEqual([]);
  });
  it("focuses an existing page in the same turn as its synchronous authority assertion", async () => {
    await f.contextMock.newPage();
    let expired = false;
    f.pageMock.bringToFront.mockImplementationOnce(async () => {
      expect(expired).toBe(false);
    });
    await pwAi.focusPageByTargetIdViaPlaywright({
      cdpUrl,
      targetId: "TARGET_1",
      assertCurrent: () => {
        queueMicrotask(() => {
          expired = true;
        });
      },
    });
    expect(f.pageMock.bringToFront).toHaveBeenCalledOnce();
    expect(expired).toBe(true);
  });
  it("does not navigate when cancellation wins navigation validation", async () => {
    const { entered, release, pause } = pauseAtBoundary();
    const validation = vi
      .spyOn(await import("./navigation-guard.js"), "assertBrowserNavigationAllowed")
      .mockImplementationOnce(() => pause(undefined));
    const controller = new AbortController();
    try {
      const creation = create({ url: "https://example.com", signal: controller.signal });
      const rejected = expect(creation).rejects.toThrow("cancelled validation");
      await entered;
      controller.abort(new Error("cancelled validation"));
      release();
      await rejected;
      expect(f.pageMock.goto).not.toHaveBeenCalled();
      expect(f.page.context().pages()).toEqual([]);
    } finally {
      release();
      validation.mockRestore();
    }
  });
  it("closes a new page when cancellation wins target resolution", async () => {
    const { entered, release, pause } = pauseAtBoundary();
    f.sessionSend.mockImplementationOnce(() => pause(targetInfo));
    const controller = new AbortController();
    const creation = create({ signal: controller.signal });
    await entered;
    controller.abort(new Error("cancelled page creation"));
    release();
    await expect(creation).rejects.toThrow("cancelled page creation");
    expect(f.pageMock.close).toHaveBeenCalledOnce();
  });
});
