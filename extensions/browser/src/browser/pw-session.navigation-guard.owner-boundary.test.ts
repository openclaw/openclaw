import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { withPageNavigationRequestGuard } from "./pw-session.js";
import { createMockRoute, type MockRoute } from "./pw-tools-core.guard-test-support.js";

const strictPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

type MockRequest = {
  isNavigationRequest: () => boolean;
  frame: () => object;
  url: () => string;
};
type MockRouteHandler = (route: MockRoute, request: MockRequest) => Promise<void>;

describe("pw-session navigation guard owner boundary", () => {
  it("aborts and drains an in-flight document policy check at the guard owner boundary", async () => {
    let routeHandler: MockRouteHandler | null = null;
    const mainFrame = {};
    const pageRoute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
      routeHandler = handler;
    });
    const pageUnroute = vi.fn(async (_pattern: string, handler: MockRouteHandler) => {
      if (routeHandler === handler) {
        routeHandler = null;
      }
    });
    const page = {
      url: () => "about:blank",
      route: pageRoute,
      unroute: pageUnroute,
      mainFrame: () => mainFrame,
    } as unknown as Page;
    const controller = new AbortController();
    const abortReason = new Error("caller aborted during policy check");
    const route = createMockRoute();
    const { promise: policyStarted, resolve: resolvePolicyStarted } = Promise.withResolvers<void>();
    const { promise: policyPending, resolve: releasePolicy } = Promise.withResolvers<void>();
    let observedPolicyCheck: Promise<void> | undefined;
    let dispatched: Promise<void> | undefined;
    let guarded: Promise<string> | undefined;
    const assertNavigationAllowedSpy = vi
      .spyOn(navigationGuardModule, "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async ({ signal }) => {
        resolvePolicyStarted();
        await Promise.race([
          policyPending,
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
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
          if (!routeHandler) {
            throw new Error("missing route handler");
          }
          dispatched = routeHandler(route, {
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            url: () => "https://93.184.216.34/page",
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
      controller.abort(abortReason);
      await expect(observedPolicyCheck).rejects.toBe(abortReason);
      await expect(guarded).rejects.toBe(abortReason);
      await expect(dispatched).resolves.toBeUndefined();

      expect(route.abort).toHaveBeenCalledOnce();
      expect(route.fallback).not.toHaveBeenCalled();
      expect(route.continue).not.toHaveBeenCalled();
      expect(pageUnroute).toHaveBeenCalledWith("**", pageRoute.mock.calls[0]?.[1]);
      expect(routeHandler).toBeNull();
    } finally {
      releasePolicy();
      await dispatched?.catch(() => {});
      await guarded?.catch(() => {});
      assertNavigationAllowedSpy.mockRestore();
    }
  });
});
