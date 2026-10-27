import type { Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { withPageNavigationRequestGuard } from "./pw-session.js";
import { createMockRoute, type MockRoute } from "./pw-tools-core.guard-test-support.js";

type MockRequest = {
  isNavigationRequest: () => boolean;
  frame: () => object;
  url: () => string;
};
type MockRouteHandler = (route: MockRoute, request: MockRequest) => Promise<void>;

it("aborts and drains an in-flight document policy check at the guard owner boundary", async () => {
  let routeHandler: MockRouteHandler | null = null;
  const mainFrame = {};
  const page = {
    url: () => "about:blank",
    route: async (_pattern: string, handler: MockRouteHandler) => {
      routeHandler = handler;
    },
    unroute: async () => {},
    mainFrame: () => mainFrame,
  } as unknown as Page;
  const controller = new AbortController();
  const abortReason = new Error("caller aborted during policy check");
  const route = createMockRoute();
  const { promise: policyStarted, resolve: resolvePolicyStarted } = Promise.withResolvers<void>();
  const policy = Promise.withResolvers<void>();
  let dispatched: Promise<void> | undefined;
  let guarded: Promise<void> | undefined;
  const assertNavigationAllowedSpy = vi
    .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
    .mockImplementationOnce(({ signal }) => {
      signal?.addEventListener("abort", () => policy.reject(signal.reason), { once: true });
      resolvePolicyStarted();
      return policy.promise;
    });

  try {
    guarded = withPageNavigationRequestGuard({
      page,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: controller.signal,
      action: async () => {
        if (!routeHandler) {
          throw new Error("missing route handler");
        }
        dispatched = routeHandler(route, {
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          url: () => "https://93.184.216.34/page",
        });
      },
    });

    await policyStarted;
    controller.abort(abortReason);
    await expect(guarded).rejects.toBe(abortReason);
    await expect(dispatched).resolves.toBeUndefined();

    expect(route.abort).toHaveBeenCalledOnce();
    expect(route.fallback).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
  } finally {
    policy.resolve();
    await dispatched?.catch(() => {});
    await guarded?.catch(() => {});
    assertNavigationAllowedSpy.mockRestore();
  }
});
