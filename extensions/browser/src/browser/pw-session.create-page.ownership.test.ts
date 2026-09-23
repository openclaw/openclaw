import type { Browser, BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, pwAi } = setupPwSessionConnectionTest();
const { createPageViaPlaywright } = pwAi;

function installBrowserMocks() {
  const openPages: Page[] = [];
  const pageGoto = vi.fn(async () => null);
  const pageClose = vi.fn(async () => {
    openPages.splice(openPages.indexOf(page), 1);
  });
  const sessionSend = vi.fn(async (_method: string) => ({
    targetInfo: { targetId: "TARGET_1", title: "" },
  }));
  const page = {
    on: vi.fn(),
    context: () => context,
    goto: pageGoto,
    close: pageClose,
    title: async () => "",
    url: () => "about:blank",
    route: vi.fn(),
    unroute: vi.fn(),
  } as unknown as Page;
  const context = {
    on: vi.fn(),
    pages: () => openPages,
    browser: () => browser,
    newPage: async () => {
      openPages.push(page);
      return page;
    },
    newCDPSession: async () => ({ send: sessionSend, detach: async () => {} }),
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  } as unknown as Browser;
  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return { page, pageGoto, pageClose, sessionSend };
}

describe("Playwright created-page ownership", () => {
  it("closes a new page when its target identity cannot be read", async () => {
    const { page, pageClose, sessionSend } = installBrowserMocks();
    sessionSend.mockRejectedValue(new Error("Target metadata unavailable"));

    await expect(
      createPageViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", url: "about:blank" }),
    ).rejects.toThrow("Failed to get targetId for new page");

    expect(pageClose).toHaveBeenCalledOnce();
    expect(page.context().pages()).toEqual([]);
  });

  it("does not navigate when cancellation wins navigation validation", async () => {
    const { pageGoto, page } = installBrowserMocks();
    let started!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const validationPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validation = vi
      .spyOn(await import("./navigation-guard.js"), "assertBrowserNavigationAllowed")
      .mockImplementationOnce(async () => {
        started();
        await validationPending;
      });
    const controller = new AbortController();
    try {
      const creation = createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com",
        signal: controller.signal,
      });
      const rejected = expect(creation).rejects.toThrow("cancelled validation");
      await validationStarted;
      controller.abort(new Error("cancelled validation"));
      release();
      await rejected;

      expect(pageGoto).not.toHaveBeenCalled();
      expect(page.context().pages()).toEqual([]);
    } finally {
      release();
      validation.mockRestore();
    }
  });

  it("closes a new page when cancellation wins target resolution", async () => {
    const { pageClose, sessionSend } = installBrowserMocks();
    let releaseTargetInfo: (() => void) | undefined;
    let markTargetInfoStarted: (() => void) | undefined;
    const targetInfoStarted = new Promise<void>((resolve) => {
      markTargetInfoStarted = resolve;
    });
    const targetInfoReleased = new Promise<void>((resolve) => {
      releaseTargetInfo = resolve;
    });
    sessionSend.mockImplementationOnce(async () => {
      markTargetInfoStarted?.();
      await targetInfoReleased;
      return { targetInfo: { targetId: "TARGET_1", title: "" } };
    });
    const controller = new AbortController();

    const creation = createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
      signal: controller.signal,
    });
    await targetInfoStarted;
    controller.abort(new Error("cancelled page creation"));
    releaseTargetInfo?.();

    await expect(creation).rejects.toThrow("cancelled page creation");
    expect(pageClose).toHaveBeenCalledOnce();
  });
});
