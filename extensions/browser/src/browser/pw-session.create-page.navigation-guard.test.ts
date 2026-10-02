import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { pwAi } from "./pw-ai.js";
import {
  assertPageNavigationCompletedSafely,
  gotoPageWithNavigationGuard,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";

const {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  listPagesViaPlaywright,
} = pwAi;
const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketEndpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint");
vi.mock(
  "./pw-session-cdp-transport.js",
  () => import("./pw-session-cdp-transport.test-support.js"),
);
const cdpUrl = "http://127.0.0.1:18792";
const publicUrl = "https://93.184.216.34/start";
const privateUrl = "http://127.0.0.1:18080/internal-hop";
const strictPolicy = { dangerouslyAllowPrivateNetwork: false } as const;
const blockedTargetMessage =
  "Browser target is unavailable after SSRF policy blocked its navigation.";

type MockRoute = {
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
  fulfill: (response: { status: number; body: string }) => Promise<void>;
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
  let routeHandler: MockRouteHandler | null = null;
  const pageGoto = vi.fn<
    (...args: unknown[]) => Promise<null | { request: () => Record<string, unknown> }>
  >(async () => null);
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
  const browserEvents = new EventEmitter();
  const sessionSend = vi.fn(async (method: string) =>
    method === "Target.getTargetInfo" ? { targetInfo: { targetId: "TARGET_1" } } : {},
  );
  const context = {
    browser: () => browser,
    pages: () => openPages,
    on: vi.fn(),
    newPage: vi.fn(async () => {
      openPages.push(page);
      return page;
    }),
    newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: vi.fn(async () => {}) })),
  } as unknown as import("playwright-core").BrowserContext;
  const page = {
    on: vi.fn(),
    context: () => context,
    goto: pageGoto,
    title: vi.fn(async () => ""),
    url: pageUrl,
    route: pageRoute,
    unroute: pageUnroute,
    close: pageClose,
    mainFrame: () => mainFrame,
  } as unknown as import("playwright-core").Page;
  const browser = {
    contexts: () => [context],
    on: browserEvents.on.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: vi.fn(async () => {}),
  } as unknown as import("playwright-core").Browser;
  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketEndpointSpy.mockResolvedValue(null);
  return {
    pageGoto,
    page,
    pageRoute,
    pageUnroute,
    pageUrl,
    pageClose,
    sessionSend,
    disconnect: () => browserEvents.emit("disconnected"),
    getRouteHandler: () => routeHandler,
    mainFrame,
    pushOpenPage: () => openPages.push(page),
  };
}

function createMockRoute(overrides?: Partial<MockRoute>): MockRoute {
  return {
    continue: vi.fn(async () => {}),
    fallback: vi.fn(async () => {}),
    fulfill: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...overrides,
  };
}
let f: ReturnType<typeof installBrowserMocks>;
function create(opts: Partial<Parameters<typeof createPageViaPlaywright>[0]> = {}) {
  return createPageViaPlaywright({ cdpUrl, url: publicUrl, ...opts });
}
function getPage(targetId?: string) {
  return getPageForTargetId({ cdpUrl, targetId });
}
function navigate(opts: Partial<Parameters<typeof gotoPageWithNavigationGuard>[0]> = {}) {
  return gotoPageWithNavigationGuard({
    cdpUrl,
    page: f.page,
    url: publicUrl,
    timeoutMs: 1000,
    ...opts,
  });
}
type GuardOptions = Parameters<typeof withPageNavigationRequestGuard>[0];
function guard(action: GuardOptions["action"], opts: Partial<GuardOptions> = {}) {
  return withPageNavigationRequestGuard({
    page: f.page,
    ssrfPolicy: strictPolicy,
    action,
    ...opts,
  });
}
async function dispatch(
  opts: {
    url?: string;
    frame?: object;
    frameError?: Error;
    isNavigationRequest?: boolean;
    resourceType?: string;
    route?: Partial<MockRoute>;
  } = {},
) {
  const handler = f.getRouteHandler();
  if (!handler) {
    throw new Error("missing route handler");
  }
  const { resourceType } = opts;
  await handler(createMockRoute(opts.route), {
    isNavigationRequest: () => opts.isNavigationRequest ?? true,
    frame: () => {
      if (opts.frameError) {
        throw opts.frameError;
      }
      return opts.frame ?? f.mainFrame;
    },
    ...(resourceType ? { resourceType: () => resourceType } : {}),
    url: () => opts.url ?? publicUrl,
  });
}
function blockedRedirect(opts: Parameters<typeof dispatch>[0] = {}) {
  f.pageGoto.mockImplementationOnce(async () => {
    await dispatch();
    await dispatch({ url: privateUrl, ...opts });
    throw new Error("Navigation aborted");
  });
}
async function denied(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(SsrFBlockedError);
  return await promise.catch((error: unknown) => error);
}
async function quarantineExistingPage(targetId: string, lookupTargetId?: string) {
  f.pageClose.mockRejectedValueOnce(new Error("close failed"));
  await create({ url: "about:blank" });
  const page = await getPage(lookupTargetId);
  f.pageGoto.mockImplementationOnce(async () => {
    await dispatch({ url: privateUrl });
    throw new Error("Navigation aborted");
  });
  f.sessionSend.mockRejectedValueOnce(new Error("Target lookup failed"));
  await denied(navigate({ page, targetId }));
  return page;
}
function failRouteSetup(error: Error) {
  const install = f.pageRoute.getMockImplementation();
  f.pageRoute.mockImplementationOnce(async (...args) => {
    await install?.(...args);
    throw error;
  });
}
function expectRouteRemoved() {
  expect(f.pageUnroute).toHaveBeenCalledWith("**", f.pageRoute.mock.calls[0]?.[1]);
  expect(f.getRouteHandler()).toBeNull();
}
function cleanupFailure(closed: boolean) {
  Object.assign(f.page, { isClosed: () => closed });
  const error = new Error("navigation route cleanup failed");
  f.pageUnroute.mockRejectedValueOnce(error);
  return error;
}
function observeDenials() {
  const events: string[] = [];
  const onPolicyDenied: GuardOptions["onPolicyDenied"] = (event) => {
    events.push(
      event.state === "detected" ? event.state : `${event.state}:${String(event.sourcePreserved)}`,
    );
  };
  return { events, onPolicyDenied };
}

beforeEach(() => {
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  f = installBrowserMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  connectOverCdpSpy.mockClear();
  getChromeWebSocketEndpointSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session createPageViaPlaywright navigation guard", () => {
  it("blocks unsupported non-network URLs", async () => {
    await expect(create({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(f.pageGoto).not.toHaveBeenCalled();
  });
  it("blocks hostname navigation when strict SSRF policy is configured", async () => {
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: "ws://127.0.0.1:18792/devtools/browser/ROOT",
    });
    await expect(
      create({
        url: "https://example.com",
        ssrfPolicy: { ...strictPolicy, allowedHostnames: ["127.0.0.1"] },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(f.pageGoto).not.toHaveBeenCalled();
  });
  it("blocks private redirect hops even when Playwright marks hop as non-navigation", async () => {
    blockedRedirect({ isNavigationRequest: false, resourceType: "document" });
    await denied(create());
    expect(f.pageGoto).toHaveBeenCalledTimes(1);
    expect(f.pageClose).toHaveBeenCalledTimes(1);
  });
  it("fails closed as a top-level navigation when request frame resolution throws", async () => {
    f.pageGoto.mockImplementationOnce(async () => {
      await dispatch({ frameError: new Error("frame detached"), url: privateUrl });
      throw new Error("Navigation aborted");
    });
    await denied(create());
    expect(f.pageClose).toHaveBeenCalledTimes(1);
  });
  it("aborts private subframe document hops without quarantining the page", async () => {
    const route = createMockRoute();
    f.pageGoto.mockImplementationOnce(async () => {
      await dispatch();
      await dispatch({ frame: {}, url: privateUrl, route });
      return { request: () => ({ url: () => publicUrl, redirectedFrom: () => null }) };
    });
    expect((await create()).targetId).toBe("TARGET_1");
    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(f.pageClose).not.toHaveBeenCalled();
  });
  it("ignores already-handled route races during guarded navigation", async () => {
    const route = createMockRoute({
      continue: vi.fn(async () => {
        throw new Error("Route is already handled");
      }),
    });
    f.pageGoto.mockImplementationOnce(async () => {
      await dispatch({ url: "https://example.com", route });
      return null;
    });
    expect((await create({ url: "https://example.com" })).targetId).toBe("TARGET_1");
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(f.pageGoto).toHaveBeenCalledTimes(1);
    expect(f.pageClose).not.toHaveBeenCalled();
  });
  it("propagates unsupported redirect protocols as navigation errors", async () => {
    blockedRedirect({ url: "file:///etc/passwd" });
    await expect(create()).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(f.pageGoto).toHaveBeenCalledTimes(1);
    expect(f.pageClose).toHaveBeenCalledTimes(1);
  });
  it("closes the created tab on transient redirect lookup errors", async () => {
    const validation = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementation(async ({ url }) => {
        if (url === privateUrl) {
          throw new Error("getaddrinfo EAI_AGAIN internal-hop");
        }
      });
    blockedRedirect();
    try {
      await expect(create()).rejects.toThrow(/getaddrinfo EAI_AGAIN internal-hop/);
      expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
      expect(f.pageClose).toHaveBeenCalledTimes(1);
    } finally {
      validation.mockRestore();
    }
  });
  it("preserves the navigation error when closing the created tab fails", async () => {
    const error = new Error("page.goto: net::ERR_CONNECTION_REFUSED");
    f.pageGoto.mockRejectedValueOnce(error);
    f.pageClose.mockRejectedValueOnce(new Error("close failed"));
    await expect(create()).rejects.toBe(error);
    expect(f.pageClose).toHaveBeenCalledTimes(1);
  });
  it("closes an unreturned tab without quarantine on transient post-navigation errors", async () => {
    const validation = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationRedirectChainAllowed")
      .mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN postcheck.example"));
    f.pageGoto.mockResolvedValueOnce({
      request: () => ({ url: () => publicUrl, redirectedFrom: () => null }),
    });
    try {
      await expect(create()).rejects.toThrow(/getaddrinfo .*postcheck\.example/);
      expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
      expect(f.pageClose).toHaveBeenCalledOnce();
      await create({ url: "about:blank" });
      await expect(getPage("TARGET_1")).resolves.toBeDefined();
    } finally {
      validation.mockRestore();
    }
  });
  it("keeps blocked tab quarantined if close fails", async () => {
    f.pageClose.mockRejectedValueOnce(new Error("close failed"));
    blockedRedirect();
    await denied(create());
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    await expect(getPage("TARGET_1")).rejects.toThrow(blockedTargetMessage);
    await expect(getPage()).rejects.toThrow(blockedTargetMessage);
    expect(f.pageClose).toHaveBeenCalledTimes(1);
  });
  it("preserves blocked-target quarantine across transport disconnects", async () => {
    f.pageClose.mockRejectedValueOnce(new Error("close failed"));
    blockedRedirect();
    await denied(create());
    expect(f.disconnect()).toBe(true);
    await expect(getPage("TARGET_1")).rejects.toThrow(blockedTargetMessage);
  });
  it("quarantines the actual page when blocked navigation receives a stale target id", async () => {
    await quarantineExistingPage("MISSING_TARGET");
    await expect(getPage()).rejects.toThrow(blockedTargetMessage);
  });
  it("falls back to caller targetId quarantine when target lookup fails", async () => {
    const page = await quarantineExistingPage("TARGET_1", "TARGET_1");
    await forceDisconnectPlaywrightForTarget({ page, cdpUrl });
    f = installBrowserMocks();
    f.pushOpenPage();
    await expect(getPage("TARGET_1")).rejects.toThrow(blockedTargetMessage);
  });
  it("does not close a user tab when a read-only caller hits an SSRF-blocked URL", async () => {
    f.pageUrl.mockReturnValue(privateUrl);
    await denied(
      assertPageNavigationCompletedSafely({
        cdpUrl,
        page: f.page,
        response: null,
        ssrfPolicy: strictPolicy,
        targetId: "TARGET_1",
      }),
    );
    expect(f.pageClose).not.toHaveBeenCalled();
  });
});

describe("pw-session guarded browser navigation route cleanup", () => {
  it("rolls back its exact navigation route when Playwright setup rejects", async () => {
    const error = new Error("navigation route setup failed");
    failRouteSetup(error);
    await expect(navigate()).rejects.toBe(error);
    expectRouteRemoved();
    expect(f.pageGoto).not.toHaveBeenCalled();
  });
  it("awaits remote ownership validation and rejects revocation before goto", async () => {
    const entered = createDeferred<void>();
    const pending = createDeferred<void>();
    const task = navigate({
      targetId: "TARGET_1",
      assertPageCurrent: async () => {
        entered.resolve();
        await pending.promise;
        throw new BrowserTabNotFoundError({ input: "TARGET_1" });
      },
    });
    const rejected = expect(task).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await entered.promise;
    expect(f.pageGoto).not.toHaveBeenCalled();
    pending.resolve();
    await rejected;
    expect(f.pageGoto).not.toHaveBeenCalled();
    expect(f.pageUnroute).toHaveBeenCalled();
  });
  it("surfaces navigation route cleanup failure while the page remains open", async () => {
    const error = cleanupFailure(false);
    await expect(navigate()).rejects.toBe(error);
  });
  it("preserves the original navigation failure when route cleanup also fails", async () => {
    cleanupFailure(false);
    const error = new Error("browser navigation failed");
    f.pageGoto.mockRejectedValueOnce(error);
    await expect(navigate()).rejects.toBe(error);
  });
  it("ignores navigation route cleanup failure after the page closes", async () => {
    cleanupFailure(true);
    await expect(navigate()).resolves.toBeNull();
  });
  it("preserves blocked-page quarantine when navigation route cleanup fails", async () => {
    blockedRedirect();
    cleanupFailure(false);
    await denied(navigate());
    expect(f.pageClose).toHaveBeenCalledOnce();
  });
});

describe("pw-session selected-page interaction request guard", () => {
  it("preserves policy-free callers without installing a route", async () => {
    await expect(guard(async () => "ok", { ssrfPolicy: undefined })).resolves.toBe("ok");
    expect(f.pageRoute).not.toHaveBeenCalled();
    expect(f.pageUnroute).not.toHaveBeenCalled();
  });
  it("fails closed before request handling when strict policy uses an explicit browser proxy", async () => {
    const route = createMockRoute();
    await expect(
      guard(
        async () => {
          await dispatch({ route });
          return "unsafe";
        },
        { browserProxyMode: "explicit-browser-proxy" },
      ),
    ).rejects.toThrow("strict browser SSRF policy cannot be enforced");
    expect(route.fallback).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
  });
  it("reports an unsafe preflight before route cleanup settles", async () => {
    const install = f.pageRoute.getMockImplementation();
    f.pageRoute.mockImplementationOnce(async (...args) => {
      await install?.(...args);
      f.pageUrl.mockReturnValue(privateUrl);
    });
    const pending = createDeferred<void>();
    const unroute = f.pageUnroute.getMockImplementation();
    f.pageUnroute.mockImplementationOnce(async (...args) => {
      await pending.promise;
      await unroute?.(...args);
    });
    const { events, onPolicyDenied } = observeDenials();
    const action = vi.fn(async () => "unsafe");
    const guarded = guard(action, { onPolicyDenied });
    await vi.waitFor(() => expect(events).toEqual(["detected", "handled:false"]));
    expect(action).not.toHaveBeenCalled();
    pending.resolve();
    await denied(guarded);
    expectRouteRemoved();
  });
  it("falls through allowed documents and subresources, then removes only its handler", async () => {
    const documentRoute = createMockRoute();
    const imageRoute = createMockRoute();
    await expect(
      guard(async () => {
        await dispatch({ route: documentRoute });
        await dispatch({
          url: "http://127.0.0.1/ignored-subresource.png",
          isNavigationRequest: false,
          resourceType: "image",
          route: imageRoute,
        });
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(documentRoute.fallback).toHaveBeenCalledTimes(1);
    expect(imageRoute.fallback).toHaveBeenCalledTimes(1);
    expect(documentRoute.continue).not.toHaveBeenCalled();
    expect(imageRoute.continue).not.toHaveBeenCalled();
    expect(f.pageRoute).toHaveBeenCalledWith("**", f.pageRoute.mock.calls[0]?.[1]);
    expectRouteRemoved();
  });
  it("answers a denied subframe document through interception and preserves the source", async () => {
    const route = createMockRoute();
    const caught = await denied(
      guard(async () => {
        await dispatch({ frame: {}, url: privateUrl, route });
        throw new Error("locator detached");
      }),
    );
    expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(route.abort).not.toHaveBeenCalled();
    expect(route.fallback).not.toHaveBeenCalled();
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(true);
    expect(f.page.url()).toBe("about:blank");
  });
  it("does not claim preservation when postflight also finds a policy violation", async () => {
    const route = createMockRoute();
    const caught = await denied(
      guard(async () => {
        await dispatch({ frame: {}, url: privateUrl, route });
        throw new SsrFBlockedError("blocked committed subframe");
      }),
    );
    expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });
  it("does not report an unsafe source while another denied fulfillment is pending", async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const firstRoute = createMockRoute({ fulfill: vi.fn(async () => await first.promise) });
    const secondRoute = createMockRoute({ fulfill: vi.fn(async () => await second.promise) });
    const { events, onPolicyDenied } = observeDenials();
    const guarded = guard(
      async () => {
        await Promise.all([
          dispatch({ url: "http://127.0.0.1:18080/first", route: firstRoute }),
          dispatch({ frame: {}, url: "http://127.0.0.1:18080/second", route: secondRoute }),
        ]);
      },
      { onPolicyDenied },
    );
    await vi.waitFor(() => {
      expect(firstRoute.fulfill).toHaveBeenCalledTimes(1);
      expect(secondRoute.fulfill).toHaveBeenCalledTimes(1);
    });
    second.resolve();
    await Promise.resolve();
    expect(events).toEqual(["detected"]);
    first.resolve();
    await denied(guarded);
    expect(events).toEqual(["detected", "handled:true"]);
  });
  it("waits for in-flight policy work before returning", async () => {
    const pending = createDeferred<void>();
    const validation = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => await pending.promise);
    const route = createMockRoute();
    let settled = false;
    let dispatched: Promise<void> | undefined;
    let observedPolicyCheck: Promise<void> | undefined;
    try {
      const guarded = guard(
        async () => {
          dispatched = dispatch({ route });
          return "ok";
        },
        {
          onPolicyCheckStarted: (check) => {
            observedPolicyCheck = check;
          },
        },
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(validation).toHaveBeenCalledTimes(1));
      expect(observedPolicyCheck).toBeInstanceOf(Promise);
      expect(f.pageUnroute).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      pending.resolve();
      await expect(guarded).resolves.toBe("ok");
      await dispatched;
      expect(route.fallback).toHaveBeenCalledTimes(1);
    } finally {
      validation.mockRestore();
    }
  });
  it("does not claim source preservation when 204 fulfillment falls back to abort", async () => {
    const route = createMockRoute({
      fulfill: vi.fn(async () => {
        throw new Error("fulfill failed");
      }),
    });
    const caught = await denied(
      guard(async () => {
        await dispatch({ url: privateUrl, route });
      }),
    );
    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });
  it("prefers a later policy denial over an earlier route failure", async () => {
    const allowedRoute = createMockRoute({
      fallback: vi.fn(async () => {
        throw new Error("fallback transport failed");
      }),
    });
    const deniedRoute = createMockRoute();
    const caught = await denied(
      guard(async () => {
        await dispatch({ route: allowedRoute });
        await dispatch({ url: privateUrl, route: deniedRoute });
      }),
    );
    expect(allowedRoute.abort).toHaveBeenCalledTimes(1);
    expect(deniedRoute.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(false);
  });
  it("removes its exact route when the action fails before a request", async () => {
    await expect(
      guard(async () => {
        throw new Error("locator failed");
      }),
    ).rejects.toThrow("locator failed");
    expectRouteRemoved();
  });
  it("rolls back its exact route when setup rejects", async () => {
    const error = new Error("route setup failed");
    failRouteSetup(error);
    const action = vi.fn(async () => "unreachable");
    await expect(guard(action)).rejects.toBe(error);
    expectRouteRemoved();
    expect(action).not.toHaveBeenCalled();
  });
  it("surfaces cleanup failure while the page remains open", async () => {
    const error = cleanupFailure(false);
    await expect(guard(async () => "ok")).rejects.toBe(error);
  });
});
