/**
 * Production-route real-timer timing proof for PR #109536.
 *
 * Exercises the actual registerBrowserTabRoutes handler with REAL timers
 * (no vi.useFakeTimers) to demonstrate that the abort-aware retry delay
 * cancels promptly rather than waiting the full 250ms retry window.
 *
 * Run BEFORE (old code):  git checkout main -- tabs.ts
 *     → expect elapsed >= 250ms (timer runs to completion)
 *
 * Run AFTER  (new code):  git checkout HEAD -- tabs.ts
 *     → expect elapsed  < 150ms (abort cancels the timer early)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

const { registerBrowserTabRoutes } = await import("./tabs.js");

function baseProfileContext() {
  return {
    profile: { name: "openclaw" },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    isHttpReachable: vi.fn(async () => true),
    isReachable: vi.fn(async () => true),
    listTabs: vi.fn(async () => [
      {
        targetId: "T1",
        title: "Tab 1",
        url: "https://example.com",
        type: "page",
      },
    ]),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    labelTab: vi.fn(async (_targetId: string, label: string) => ({
      suggestedTargetId: label,
      targetId: "T1",
      tabId: "t1",
      label,
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "" })),
  };
}

function createProfileContext(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
  return { ...baseProfileContext(), ...overrides };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    state: () => ({ resolved: { actionTimeoutMs: 45_000, extraArgs: [], ssrfPolicy: undefined } }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn((_err: unknown) => {
      // Unmapped errors (like non-BrowserError) return null, falling through
      // to jsonError(res, 500, String(err)).
      return null as never;
    }),
    ensureBrowserAvailable: profileCtx.ensureBrowserAvailable,
    ensureTabAvailable: profileCtx.ensureTabAvailable,
    isHttpReachable: profileCtx.isHttpReachable,
    isReachable: profileCtx.isReachable,
    listTabs: profileCtx.listTabs,
    openTab: profileCtx.openTab,
    labelTab: profileCtx.labelTab,
    focusTab: profileCtx.focusTab,
    closeTab: profileCtx.closeTab,
    stopRunningBrowser: profileCtx.stopRunningBrowser,
    resetProfile: profileCtx.resetProfile,
  };
}

async function callTabsAction(params: {
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
  signal?: AbortSignal;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(app, createRouteContext(params.profileCtx) as never);
  const handler = postHandlers.get("/tabs/action");
  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: {},
      body: params.body ?? {},
      ...(params.signal ? { signal: params.signal } : {}),
    },
    response.res,
  );
  return response;
}

describe("PR #109536 — production-route abort timing proof", () => {
  beforeEach(() => {
    navigationGuardMocks.assertBrowserNavigationAllowed.mockReset();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockImplementation((ssrfPolicy?: unknown) =>
      ssrfPolicy ? { ssrfPolicy } : {},
    );
  });

  it("aborts promptly during the retry delay (real timers)", async () => {
    const abort = new AbortController();
    const isReachable = vi.fn(async () => false);
    const profileCtx = createProfileContext({ isReachable });

    const start = performance.now();

    const responsePromise = callTabsAction({
      body: { action: "close", index: 0 },
      profileCtx,
      signal: abort.signal,
    });

    // Wait long enough for the first reachability probe to resolve and the
    // retry delay to start (async fn yields after `await isReachable(...)`),
    // but well before the full 250ms retry window expires.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const abortReason = new Error("cancelled");
    abort.abort(abortReason);

    const response = await responsePromise;
    const elapsed = performance.now() - start;

    // --- Abort reason preservation ---
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: "Error: cancelled" });

    // --- No second reachability probe ---
    expect(isReachable).toHaveBeenCalledTimes(1);

    // --- Timing: abort must cancel promptly, not wait 250ms ---
    // With the old `new Promise(setTimeout)` the handler completes after the
    // full retry delay (~250ms). With sleepWithAbort the abort is detected
    // within one event-loop tick (~50ms).  150ms is the midpoint threshold.
    expect(elapsed).toBeLessThan(150);

    // Emit timing for PR body transcript
    console.log(
      `\n  === PR #109536 — Production-Route Real-Timer Proof ===` +
        `\n  Status:           ${response.statusCode}` +
        `\n  Response body:    ${JSON.stringify(response.body)}` +
        `\n  Reachability probes: ${isReachable.mock.calls.length}` +
        `\n  Total elapsed:    ${elapsed.toFixed(1)}ms` +
        `\n  Threshold:        < 150ms ✓` +
        `\n  ================================================\n`,
    );
  });
});
