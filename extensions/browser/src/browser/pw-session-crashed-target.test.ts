import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { BROWSER_ACT_ERROR_CODES, CrashedBrowserTargetError } from "./errors.js";
import { ensurePageState } from "./pw-session-state.js";
import { isPageCrashed, translateCrashedPageError } from "./pw-session-crash-state.js";

function stubPage(): Page {
  return new EventEmitter() as unknown as Page;
}

describe("crashed browser target handling", () => {
  it("marks a page as crashed when Playwright emits the crash event", () => {
    const page = stubPage();
    expect(isPageCrashed(page)).toBe(false);

    ensurePageState(page);
    page.emit("crash");

    expect(isPageCrashed(page)).toBe(true);
  });

  it("translates Playwright Target crashed failures into the explicit crash error", () => {
    const translated = translateCrashedPageError(
      new Error("page.screenshot: Target crashed"),
    );
    expect(translated).toBeInstanceOf(CrashedBrowserTargetError);
    expect(translated?.message).toBe("tab crashed (renderer exited); open the URL in a new tab");
    expect(translated?.code).toBe(BROWSER_ACT_ERROR_CODES.operationFailed);
    expect(translated?.cause).toBeInstanceOf(Error);
  });

  it("translates non-Error crash rejections and leaves unrelated failures alone", () => {
    expect(translateCrashedPageError("page.route: Target crashed")).toBeInstanceOf(
      CrashedBrowserTargetError,
    );
    expect(translateCrashedPageError(new Error("Timeout 20000ms exceeded."))).toBeNull();
    expect(
      translateCrashedPageError(new Error("Target page, context or browser has been closed")),
    ).toBeNull();
  });
});
