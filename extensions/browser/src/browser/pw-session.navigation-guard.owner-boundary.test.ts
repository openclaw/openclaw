import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import * as navigationGuardModule from "./navigation-guard.js";
import { withPageNavigationRequestGuard } from "./pw-session.js";
import { createMockRoute } from "./pw-tools-core.guard-test-support.js";

it("aborts and drains an in-flight document policy check at the guard owner boundary", async () => {
  const route = createMockRoute();
  const handled = Promise.withResolvers<void>();
  const send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main" } } };
    }
    if (method === "Fetch.failRequest") {
      await route.abort();
      handled.resolve();
    }
    if (method === "Fetch.continueRequest") {
      await route.continue();
    }
    return {};
  });
  const session = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
  const page = Object.assign(new EventEmitter(), {
    url: () => "about:blank",
    isClosed: () => false,
    context: () => ({ newCDPSession: async () => session }),
  }) as unknown as Page;
  const controller = new AbortController();
  const abortReason = new Error("caller aborted during policy check");
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
        session.emit("Fetch.requestPaused", {
          requestId: "document",
          resourceType: "Document",
          frameId: "main",
          request: { url: "https://93.184.216.34/page" },
        });
        dispatched = handled.promise;
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
