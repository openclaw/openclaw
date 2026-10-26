// Browser tests cover selected-page navigation guard owner-boundary cleanup.
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { withPageNavigationRequestGuard } from "./pw-session.js";
import { createMockRoute, type MockRoute } from "./pw-tools-core.guard-test-support.js";

const strictPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

type MockRequest = {
  isNavigationRequest: () => boolean;
  frame: () => object;
  url: () => string;
};
type MockRouteHandler = (route: MockRoute, request: MockRequest) => Promise<void>;

function installBrowserMocks() {
  let routeHandler: MockRouteHandler | null = null;
  const pageRoute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
    routeHandler = handler;
  });
  const pageUnroute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
    if (routeHandler === handler) {
      routeHandler = null;
    }
  });
  const mainFrame = {};
  const page = {
    url: vi.fn(() => "about:blank"),
    route: pageRoute,
    unroute: pageUnroute,
    mainFrame: () => mainFrame,
  } as unknown as Page;

  return {
    page,
    pageRoute,
    pageUnroute,
    getRouteHandler: () => routeHandler,
    mainFrame,
  };
}

async function dispatchMockNavigation(params: {
  getRouteHandler: () => MockRouteHandler | null;
  mainFrame: object;
  url: string;
  route?: Partial<MockRoute>;
}) {
  const handler = params.getRouteHandler();
  if (!handler) {
    throw new Error("missing route handler");
  }
  await handler(createMockRoute(params.route), {
    isNavigationRequest: () => true,
    frame: () => params.mainFrame,
    url: () => params.url,
  });
}

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pw-session navigation guard owner boundary", () => {
  it("aborts and drains an in-flight document policy check at the guard owner boundary", async () => {
    const { getRouteHandler, mainFrame, page, pageRoute, pageUnroute } = installBrowserMocks();
    const controller = new AbortController();
    const abortReason = new Error("caller aborted during policy check");
    const route = createMockRoute();
    const { promise: policyStarted, resolve: resolvePolicyStarted } = Promise.withResolvers<void>();
    const { promise: policyPending, resolve: releasePolicy } = Promise.withResolvers<void>();
    let observedPolicySignal: AbortSignal | undefined;
    let observedPolicyCheck: Promise<void> | undefined;
    let dispatched: Promise<void> | undefined;
    let guarded: Promise<string> | undefined;
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async ({ signal }) => {
        observedPolicySignal = signal;
        resolvePolicyStarted();
        if (!signal) {
          await policyPending;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(String(signal.reason ?? "aborted")),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void policyPending.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
          if (signal.aborted) {
            onAbort();
          }
        });
      });

    try {
      guarded = withPageNavigationRequestGuard({
        page,
        ssrfPolicy: strictPolicy,
        signal: controller.signal,
        onPolicyCheckStarted: (check) => {
          observedPolicyCheck = check;
        },
        action: async () => {
          dispatched = dispatchMockNavigation({
            getRouteHandler,
            mainFrame,
            url: "https://93.184.216.34/page",
            route,
          });
          return "ok";
        },
      });

      await policyStarted;
      expect(assertNavigationAllowedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: controller.signal,
          url: "https://93.184.216.34/page",
        }),
      );
      expect(observedPolicySignal).toBe(controller.signal);
      expect(observedPolicyCheck).toBeInstanceOf(Promise);

      controller.abort(abortReason);
      expect(observedPolicySignal?.aborted).toBe(true);
      expect(observedPolicySignal?.reason).toBe(abortReason);
      await expect(observedPolicyCheck).rejects.toBe(abortReason);
      await expect(guarded).rejects.toBe(abortReason);
      await expect(dispatched).resolves.toBeUndefined();

      expect(route.abort).toHaveBeenCalledOnce();
      expect(route.fallback).not.toHaveBeenCalled();
      expect(route.continue).not.toHaveBeenCalled();
      expect(pageUnroute).toHaveBeenCalledWith("**", pageRoute.mock.calls[0]?.[1]);
      expect(getRouteHandler()).toBeNull();
    } finally {
      releasePolicy();
      await dispatched?.catch(() => {});
      await guarded?.catch(() => {});
      assertNavigationAllowedSpy.mockRestore();
    }
  });
});
