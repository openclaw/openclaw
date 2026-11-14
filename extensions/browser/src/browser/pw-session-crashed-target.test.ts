import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { BROWSER_ACT_ERROR_CODES, CrashedBrowserTargetError } from "./errors.js";
import { isPageCrashed, translateCrashedPageError } from "./pw-session-crash-state.js";
import { ensurePageState } from "./pw-session-state.js";
import { awaitActionWithAbort } from "./pw-tools-core.interactions.navigation.js";

type StubPage = Page & { emit: EventEmitter["emit"] };

function stubPage(): StubPage {
  return new EventEmitter() as unknown as StubPage;
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
    const translated = translateCrashedPageError(new Error("page.screenshot: Target crashed"));
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

describe("crash failures at the shared action boundary", () => {
  it("translates a crashed-page action rejection into the explicit crash error", async () => {
    await expect(
      awaitActionWithAbort(
        Promise.reject(new Error("page.screenshot: Target crashed")),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(CrashedBrowserTargetError);
  });

  it("leaves timeout and close-shaped failures unchanged at the action boundary", async () => {
    await expect(
      awaitActionWithAbort(
        Promise.reject(new Error("Timeout 20000ms exceeded.")),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Timeout 20000ms exceeded.");
    await expect(
      awaitActionWithAbort(
        Promise.reject(new Error("Target page, context or browser has been closed")),
        new AbortController().signal,
      ),
    ).rejects.toThrow("has been closed");
  });
});
