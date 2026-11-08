import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_TAB_CRASHED_MESSAGE } from "./errors.js";
import {
  assertPageNotCrashed,
  bindRoleRefsTarget,
  ensurePageState,
  isPageCrashed,
} from "./pw-session-state.js";

const cdpUrl = "http://127.0.0.1:9222";

function makePage() {
  const handlers = new Map<string, () => void>();
  const page = {
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
  } as unknown as Page;
  return { page, handlers };
}

describe("page crash state", () => {
  it("refuses actions once the renderer crashes", () => {
    const { page, handlers } = makePage();
    bindRoleRefsTarget(page, cdpUrl, "T1");
    expect(isPageCrashed(page)).toBe(false);

    handlers.get("crash")?.();

    expect(isPageCrashed(page)).toBe(true);
    expect(() => assertPageNotCrashed(page)).toThrowError(BROWSER_TAB_CRASHED_MESSAGE);
  });

  it("carries the crash to a replacement Page object for the same target", () => {
    const first = makePage();
    bindRoleRefsTarget(first.page, cdpUrl, "T2");
    first.handlers.get("crash")?.();

    // Reconnects and re-enumeration hand out a new Page for the same CDP target.
    const second = makePage();
    bindRoleRefsTarget(second.page, cdpUrl, "T2");

    expect(isPageCrashed(second.page)).toBe(true);
    expect(() => assertPageNotCrashed(second.page)).toThrowError(BROWSER_TAB_CRASHED_MESSAGE);
  });

  it("keeps other targets in the same browser usable", () => {
    const crashed = makePage();
    bindRoleRefsTarget(crashed.page, cdpUrl, "T3");
    crashed.handlers.get("crash")?.();

    const other = makePage();
    bindRoleRefsTarget(other.page, cdpUrl, "T4");

    expect(isPageCrashed(other.page)).toBe(false);
    expect(() => assertPageNotCrashed(other.page)).not.toThrow();
  });

  it("ignores a crash for a page whose state was never registered", () => {
    const { page } = makePage();
    expect(isPageCrashed(page)).toBe(false);
    expect(() => assertPageNotCrashed(page)).not.toThrow();
    expect(ensurePageState(page).crashed).toBeUndefined();
  });
});
