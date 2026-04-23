// Regression tests for #70337 — `snapshotRoleViaPlaywright` with
// `refsMode: "aria"` used to throw `"refs=aria requires Playwright
// _snapshotForAI support."` when the private Playwright helper was
// missing (e.g. older playwright-core builds, certain Windows bundle
// variants). The browser tool then surfaced an unactionable error
// instead of degrading to the public ariaSnapshot() path.
//
// Behavior under test:
//   - When `_snapshotForAI` is present, prefer it (existing path).
//   - When `_snapshotForAI` is absent, silently fall back to
//     `locator(":root").ariaSnapshot()` and return role-based refs.
//   - Selector/frame snapshots with refs=aria still throw (out of scope).
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  gotoPageWithNavigationGuard: vi.fn(async () => null),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
}));

const pageCdpMocks = vi.hoisted(() => ({
  withPageScopedCdpClient: vi.fn(
    async ({ fn }: { fn: (send: () => Promise<unknown>) => unknown }) =>
      await fn(async () => ({ nodes: [] })),
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-session.page-cdp.js", () => pageCdpMocks);

const snapshots = await import("./pw-tools-core.snapshot.js");

describe("snapshotRoleViaPlaywright refs=aria fallback (#70337)", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
  });

  it("uses _snapshotForAI when available (no fallback needed)", async () => {
    const snapshotForAI = vi.fn(async () => ({ full: "" }));
    pageState.page = {
      _snapshotForAI: snapshotForAI,
      url: vi.fn(() => "https://example.com"),
      locator: vi.fn(() => ({ ariaSnapshot: vi.fn(async () => "") })),
    };

    await snapshots.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      refsMode: "aria",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(snapshotForAI).toHaveBeenCalledTimes(1);
  });

  it("falls back to ariaSnapshot when _snapshotForAI is missing", async () => {
    const ariaSnapshot = vi.fn(async () => "");
    const locatorFn = vi.fn(() => ({ ariaSnapshot }));
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      locator: locatorFn,
      // NB: no _snapshotForAI here — pre-fix this would have thrown.
    };

    const result = await snapshots.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      refsMode: "aria",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBeDefined();
    expect(ariaSnapshot).toHaveBeenCalled();
    expect(locatorFn).toHaveBeenCalledWith(":root");
  });

  it("still rejects refs=aria + selector snapshots (out of scope for fallback)", async () => {
    pageState.page = {
      url: vi.fn(() => "https://example.com"),
      locator: vi.fn(() => ({ ariaSnapshot: vi.fn(async () => "") })),
    };

    await expect(
      snapshots.snapshotRoleViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        refsMode: "aria",
        selector: "main",
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toThrow(/refs=aria does not support selector\/frame snapshots/);
  });
});
