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
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const mainFrame = {};
  const page = {
    mainFrame: vi.fn(() => mainFrame),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  } as unknown as Page;
  return { page, handlers, mainFrame };
}

describe("page crash state", () => {
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

  it("keeps crash identity after navigation clears the role refs", () => {
    const first = makePage();
    bindRoleRefsTarget(first.page, cdpUrl, "T5");
    // Main-frame navigation drains document-scoped refs before the renderer dies.
    first.handlers.get("framenavigated")?.(first.mainFrame);
    expect(ensurePageState(first.page).roleRefsTargetKey).toBeUndefined();
    first.handlers.get("crash")?.();

    const replacement = makePage();
    bindRoleRefsTarget(replacement.page, cdpUrl, "T5");

    expect(isPageCrashed(replacement.page)).toBe(true);
  });
});
