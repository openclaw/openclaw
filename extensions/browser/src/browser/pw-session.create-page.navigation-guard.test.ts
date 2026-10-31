import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { chromium, errors } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { pwAi } from "./pw-ai.js";
import {
  assertPageNavigationCompletedSafely,
  forceDisconnectPlaywrightForTarget,
  gotoPageWithNavigationGuard,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";
import { createMockRoute, type MockRoute } from "./pw-tools-core.guard-test-support.js";

const {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
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

function installBrowserMocks() {
  const pageGoto = vi.fn<
    (...args: unknown[]) => Promise<null | { request: () => Record<string, unknown> }>
  >(async () => null);
  const pageUrl = vi.fn(() => "about:blank");
  const openPages: import("playwright-core").Page[] = [];
  const pageEvents = new EventEmitter();
  const pageClose = vi.fn(async () => {
    const index = openPages.indexOf(page);
    if (index >= 0) {
      openPages.splice(index, 1);
    }
  });
  const mainFrame = {};
  const browserEvents = new EventEmitter();
  const pauses = new Map<string, { route: MockRoute; done: PromiseWithResolvers<void> }>();
  let targetLookupError: Error | undefined;
  const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Target.getTargetInfo") {
      if (targetLookupError) {
        const error = targetLookupError;
        targetLookupError = undefined;
        throw error;
      }
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main" } } };
    }
    const requestId = typeof params?.requestId === "string" ? params.requestId : "";
    const paused = pauses.get(requestId);
    if (paused) {
      if (method === "Fetch.continueRequest") {
        await paused.route.fallback();
      } else if (method === "Fetch.fulfillRequest") {
        await paused.route.fulfill({
          status: Number(params?.responseCode),
          body: typeof params?.body === "string" ? params.body : "",
        });
      } else if (method === "Fetch.failRequest") {
        if (params?.errorReason === "Aborted") {
          await paused.route.fulfill({ status: 204, body: "" });
        } else {
          await paused.route.abort();
        }
      }
      paused.done.resolve();
    }
    return {};
  });
  const sessionDetach = vi.fn(async () => {});
  const session = Object.assign(new EventEmitter(), {
    send: sessionSend,
    detach: sessionDetach,
  });
  const newCDPSession = vi.fn(async () => session);
  const context = {
    browser: () => browser,
    pages: () => openPages,
    on: vi.fn(),
    newPage: vi.fn(async () => {
      openPages.push(page);
      return page;
    }),
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;
  const page = {
    on: pageEvents.on.bind(pageEvents),
    off: pageEvents.off.bind(pageEvents),
    once: pageEvents.once.bind(pageEvents),
    isClosed: vi.fn(() => false),
    context: () => context,
    goto: pageGoto,
    title: vi.fn(async () => ""),
    url: pageUrl,
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
    pageUrl,
    pageClose,
    sessionSend,
    sessionDetach,
    newCDPSession,
    session,
    pauses,
    failTargetLookup: () => {
      targetLookupError = new Error("Target lookup failed");
    },
    disconnect: () => browserEvents.emit("disconnected"),
    mainFrame,
    pushOpenPage: () => openPages.push(page),
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
    isNavigationRequest?: boolean;
    resourceType?: string;
    route?: Partial<MockRoute>;
  } = {},
) {
  const route = createMockRoute(opts.route);
  if (opts.isNavigationRequest === false && opts.resourceType !== "document") {
    return route;
  }
  const requestId = `document-${f.pauses.size + 1}`;
  const done = Promise.withResolvers<void>();
  f.pauses.set(requestId, { route, done });
  f.session.emit("Network.requestWillBeSent", {
    requestId,
    type: "Document",
    frameId: opts.frame ? "child" : "main",
  });
  f.session.emit("Fetch.requestPaused", {
    requestId,
    networkId: requestId,
    frameId: opts.frame ? "child" : "main",
    resourceType: "Document",
    request: { url: opts.url ?? publicUrl },
  });
  await done.promise;
  f.session.emit("Network.loadingFinished", { requestId });
  return route;
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
  f.failTargetLookup();
  await denied(navigate({ page, targetId }));
  return page;
}
function failRouteSetup(error: Error) {
  vi.spyOn(f.page.context(), "newCDPSession").mockRejectedValueOnce(error);
}
function expectRouteRemoved() {
  expect(f.sessionDetach).toHaveBeenCalledOnce();
  expect(f.session.listenerCount("Fetch.requestPaused")).toBe(0);
}
function cleanupFailure(closed: boolean) {
  Object.assign(f.page, { isClosed: () => closed });
  const error = new Error("navigation CDP cleanup failed");
  f.sessionDetach.mockRejectedValueOnce(error);
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
  it("does not navigate after preview authority is revoked during page preparation", async () => {
    let current = true;
    vi.spyOn(f.page.context(), "newPage").mockImplementationOnce(async () => {
      current = false;
      return f.page;
    });
    await expect(
      create({
        assertNavigationCurrent: () => {
          if (!current) {
            throw new Error("preview invocation revoked");
          }
        },
      }),
    ).rejects.toThrow("preview invocation revoked");
    expect(f.pageGoto).not.toHaveBeenCalled();
    expect(f.pageClose).toHaveBeenCalledOnce();
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
  it("opens a slow page within the requested navigation budget", async () => {
    f.pageGoto.mockImplementationOnce(async (_url, options) => {
      const { timeout } = options as { timeout: number };
      if (timeout < 40_000) {
        throw new errors.TimeoutError("load took longer than the navigation budget");
      }
      f.pageUrl.mockReturnValue(publicUrl);
      return null;
    });
    await expect(create({ timeoutMs: 60_000 })).resolves.toMatchObject({
      targetId: "TARGET_1",
      url: publicUrl,
    });
    expect(await getPage("TARGET_1")).toBe(f.page);
  });
  it("checks the committed URL before retaining a timed-out tab", async () => {
    getChromeWebSocketEndpointSpy.mockResolvedValue({
      url: "ws://127.0.0.1:18792/devtools/browser/ROOT",
    });
    f.pageGoto.mockImplementationOnce(async () => {
      f.pageUrl.mockReturnValue(privateUrl);
      throw new errors.TimeoutError("load event timed out");
    });
    await denied(create({ ssrfPolicy: strictPolicy }));
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    expect(f.pageClose).toHaveBeenCalledOnce();
  });
  it("closes a timed-out tab if its caller was cancelled", async () => {
    const controller = new AbortController();
    const error = new Error("caller cancelled");
    f.pageGoto.mockImplementationOnce(async () => {
      f.pageUrl.mockReturnValue(publicUrl);
      controller.abort(error);
      throw new errors.TimeoutError("load event timed out");
    });
    await expect(create({ signal: controller.signal })).rejects.toBe(error);
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    expect(f.pageClose).toHaveBeenCalledOnce();
  });
  it("closes the created page to interrupt an opening navigation on cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const started = createDeferred<void>();
    const navigation = createDeferred<null>();
    const closed = new Error("Target page has been closed");
    f.pageGoto.mockImplementationOnce(() => {
      started.resolve();
      return navigation.promise;
    });
    const closePage = f.pageClose.getMockImplementation();
    if (!closePage) {
      throw new Error("missing page cleanup fixture");
    }
    f.pageClose.mockImplementationOnce(async () => {
      await closePage();
      navigation.reject(closed);
    });
    const result = create({ signal: controller.signal }).catch((error: unknown) => error);
    await started.promise;
    try {
      controller.abort(reason);
      expect(f.pageClose).toHaveBeenCalledOnce();
      expect(await result).toBe(reason);
      expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    } finally {
      navigation.reject(closed);
      await result;
    }
  });
  it("closes a page allocated after cancellation without starting navigation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during allocation");
    const allocating = createDeferred<void>();
    const allocation = createDeferred<import("playwright-core").Page>();
    vi.spyOn(f.page.context(), "newPage").mockImplementationOnce(() => {
      allocating.resolve();
      return allocation.promise;
    });
    const result = create({ signal: controller.signal }).catch((error: unknown) => error);
    await allocating.promise;
    controller.abort(reason);
    f.pushOpenPage();
    allocation.resolve(f.page);
    expect(await result).toBe(reason);
    expect(f.pageGoto).not.toHaveBeenCalled();
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    expect(f.pageClose).toHaveBeenCalledOnce();
  });
  it("releases cancellation cleanup when a committed timed-out page is handed off", async () => {
    const controller = new AbortController();
    f.pageGoto.mockImplementationOnce(async () => {
      f.pageUrl.mockReturnValue(publicUrl);
      throw new errors.TimeoutError("load event timed out");
    });
    const owned = await create({ signal: controller.signal });
    expect(owned).toMatchObject({ targetId: "TARGET_1", url: publicUrl });
    controller.abort(new Error("caller finished"));
    expect(await getPage(owned.targetId)).toBe(f.page);
    expect(f.pageClose).not.toHaveBeenCalled();
    await owned.close();
    expect(f.pageClose).toHaveBeenCalledOnce();
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
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
    cleanupFailure(false);
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
    blockedRedirect({ isNavigationRequest: false, resourceType: "document" });
    await denied(create());
    expect(f.pageGoto).toHaveBeenCalledOnce();
    expect(await listPagesViaPlaywright({ cdpUrl })).toHaveLength(0);
    expect(f.disconnect()).toBe(true);
    await expect(getPage("TARGET_1")).rejects.toThrow(blockedTargetMessage);
    await expect(getPage()).rejects.toThrow(blockedTargetMessage);
    expect(f.pageClose).toHaveBeenCalledTimes(1);
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

describe("pw-session guarded browser navigation interception cleanup", () => {
  it("does not navigate when CDP interception setup rejects", async () => {
    const error = new Error("navigation interception setup failed");
    failRouteSetup(error);
    await expect(navigate()).rejects.toBe(error);
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
    expectRouteRemoved();
  });
  it("surfaces navigation interception cleanup failure while the page remains open", async () => {
    const error = cleanupFailure(false);
    await expect(navigate()).rejects.toBe(error);
  });
  it("ignores navigation interception cleanup failure after the page closes", async () => {
    cleanupFailure(true);
    await expect(navigate()).resolves.toBeNull();
  });
  it("preserves blocked-page quarantine when navigation interception cleanup fails", async () => {
    blockedRedirect();
    cleanupFailure(false);
    await denied(navigate());
    expect(f.pageClose).toHaveBeenCalledOnce();
  });
});

describe("pw-session selected-page interaction request guard", () => {
  it("preserves policy-free callers without installing interception", async () => {
    await expect(guard(async () => "ok", { ssrfPolicy: undefined })).resolves.toBe("ok");
    expect(f.newCDPSession).not.toHaveBeenCalled();
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
  it("reports an unsafe preflight detected during interception setup", async () => {
    const implementation = f.newCDPSession.getMockImplementation();
    f.newCDPSession.mockImplementationOnce(async () => {
      const result = await implementation!();
      f.pageUrl.mockReturnValue(privateUrl);
      return result;
    });
    const { events, onPolicyDenied } = observeDenials();
    const action = vi.fn(async () => "unsafe");
    await denied(guard(action, { onPolicyDenied }));
    expect(events).toEqual(["detected", "handled:false"]);
    expect(action).not.toHaveBeenCalled();
    expectRouteRemoved();
  });
  it("intercepts documents without routing subresources", async () => {
    const documentRoute = createMockRoute();
    await expect(
      guard(async () => {
        await dispatch({ route: documentRoute });
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(documentRoute.fallback).toHaveBeenCalledTimes(1);
    expect(documentRoute.continue).not.toHaveBeenCalled();
    expect(f.sessionSend).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
    expectRouteRemoved();
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
        throw new Error("locator detached");
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
    const caught = await denied(guarded);
    expect(events).toEqual(["detected", "handled:true"]);
    expect(secondRoute.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    expect(secondRoute.abort).not.toHaveBeenCalled();
    expect(secondRoute.fallback).not.toHaveBeenCalled();
    expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(caught)).toBe(true);
    expect(f.page.url()).toBe("about:blank");
  });
  it("waits for in-flight policy work before returning", async () => {
    const pending = createDeferred<void>();
    const validation = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => await pending.promise);
    const route = createMockRoute();
    let settled = false;
    let dispatched: Promise<MockRoute> | undefined;
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
      expect(f.sessionDetach).not.toHaveBeenCalled();
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
    expect(f.session.listenerCount("Fetch.requestPaused")).toBe(0);
    expect(action).not.toHaveBeenCalled();
  });
  it("surfaces cleanup failure while the page remains open", async () => {
    const error = cleanupFailure(false);
    await expect(guard(async () => "ok")).rejects.toBe(error);
  });
});
