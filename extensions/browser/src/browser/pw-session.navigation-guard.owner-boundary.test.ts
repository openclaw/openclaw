import { EventEmitter } from "node:events";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("document requests the page issues during the action", () => {
  const blocked = new SsrFBlockedError("browser navigation blocked by policy");
  const unresolvable = Object.assign(new Error("getaddrinfo ENOTFOUND ads.invalid"), {
    code: "ENOTFOUND",
  });

  function guardedPage() {
    const route = createMockRoute();
    const failReasons: string[] = [];
    const send = vi.fn(async (method: string, params?: { errorReason?: string }) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main" } } };
      }
      if (method === "Fetch.failRequest") {
        failReasons.push(params?.errorReason ?? "");
        await route.abort();
      }
      return {};
    });
    const session = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
    const page = Object.assign(new EventEmitter(), {
      url: () => "about:blank",
      isClosed: () => false,
      context: () => ({ newCDPSession: async () => session }),
    }) as unknown as Page;
    const requestDocument = (frameId: string) =>
      session.emit("Fetch.requestPaused", {
        requestId: `${frameId}-document`,
        resourceType: "Document",
        frameId,
        request: { url: "https://ads.invalid/" },
      });
    return { page, route, failReasons, requestDocument };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["denied", blocked],
    ["unresolvable", unresolvable],
  ])("aborts a %s subframe document and returns the action's result", async (_kind, failure) => {
    vi.spyOn(navigationGuardModule, "assertBrowserNavigationAllowed").mockRejectedValue(failure);
    const { page, route, failReasons, requestDocument } = guardedPage();
    const onPolicyCheckStarted = vi.fn();
    const onPolicyDenied = vi.fn();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        onPolicyCheckStarted,
        onPolicyDenied,
        action: async () => {
          requestDocument("iframe");
          return "ok";
        },
      }),
    ).resolves.toBe("ok");

    expect(route.abort).toHaveBeenCalledOnce();
    expect(failReasons).toEqual(["Aborted"]);
    expect(onPolicyCheckStarted).not.toHaveBeenCalled();
    // A policy denial is still reported for callers that wait on that frame.
    expect(onPolicyDenied.mock.calls).toEqual(
      failure === blocked ? [[{ state: "subframe", error: blocked }]] : [],
    );
  });

  it("still fails the action when authority is revoked during a subframe check", async () => {
    const revoked = new Error("invocation revoked during redirect");
    let current = true;
    // The revocation lands while the subframe's own check is in flight, the way
    // a redirect hop revokes it, so setup and the action's start still pass and
    // the check surfaces it through the authority assertion it was handed.
    vi.spyOn(navigationGuardModule, "assertBrowserNavigationAllowed").mockImplementation(
      async (options) => {
        current = false;
        options.assertNavigationCurrent?.();
        throw blocked;
      },
    );
    const { page, requestDocument } = guardedPage();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        assertNavigationCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
        action: async () => {
          requestDocument("iframe");
          return "ok";
        },
      }),
    ).rejects.toBe(revoked);
  });

  it("still fails the action on a denied main-frame document", async () => {
    vi.spyOn(navigationGuardModule, "assertBrowserNavigationAllowed").mockRejectedValue(blocked);
    const { page, route, failReasons, requestDocument } = guardedPage();
    const onPolicyDenied = vi.fn();

    await expect(
      withPageNavigationRequestGuard({
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        onPolicyDenied,
        action: async () => {
          requestDocument("main");
          return "ok";
        },
      }),
    ).rejects.toBe(blocked);

    expect(route.abort).toHaveBeenCalledOnce();
    expect(failReasons).toEqual(["Aborted"]);
    expect(onPolicyDenied).toHaveBeenCalledWith({ state: "detected", error: blocked });
  });
});
