// Browser tests cover exact-target cleanup for unfinished page execution.
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import {
  closeBrowserTargetForUnsafePageExecution,
  closePlaywrightBrowserConnection,
  listPagesViaPlaywright,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function installBrowserMock() {
  const browserSessionSend =
    vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
  const browserSessionDetach = vi.fn(async () => {});
  const pageSessionSend = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    return {};
  });
  const pageSessionDetach = vi.fn(async () => {});
  const context = {
    browser: () => browser,
    newCDPSession: vi.fn(async () => ({
      send: pageSessionSend,
      detach: pageSessionDetach,
    })),
    on: vi.fn(),
    pages: () => [page],
  } as unknown as import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const newBrowserCDPSession = vi.fn(async () => ({
    send: browserSessionSend,
    detach: browserSessionDetach,
  }));
  const browser = {
    close: browserClose,
    contexts: () => [context],
    isConnected: () => true,
    newBrowserCDPSession,
    off: vi.fn(),
    on: vi.fn(),
  } as unknown as import("playwright-core").Browser;
  const page = {
    context: () => context,
    on: vi.fn(),
    title: vi.fn(async () => "target"),
    url: vi.fn(() => "https://example.com"),
  } as unknown as import("playwright-core").Page;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return {
    browserClose,
    browserSessionDetach,
    browserSessionSend,
    newBrowserCDPSession,
    page,
  };
}

async function connectMockBrowser(): Promise<void> {
  await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:18792" });
}

describe("unsafe page execution target cleanup", () => {
  beforeEach(() => {
    connectOverCdpSpy.mockReset();
    getChromeWebSocketUrlSpy.mockReset();
  });

  afterEach(async () => {
    await closePlaywrightBrowserConnection().catch(() => {});
  });

  it("closes and verifies only the exact target on the active browser connection", async () => {
    const mocks = installBrowserMock();
    mocks.browserSessionSend
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ targetInfos: [{ targetId: "OTHER" }] });
    await connectMockBrowser();
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await closeBrowserTargetForUnsafePageExecution({
      cdpUrl: "http://127.0.0.1:18792",
      page: mocks.page,
      targetId: "TARGET_1",
      ssrfPolicy,
    });

    expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
    expect(mocks.newBrowserCDPSession).toHaveBeenCalledTimes(1);
    expect(mocks.browserSessionSend.mock.calls).toEqual([
      ["Target.closeTarget", { targetId: "TARGET_1" }],
      ["Target.getTargets"],
    ]);
    expect(mocks.browserSessionDetach).toHaveBeenCalledTimes(1);
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("does not treat target-list absence as affirmative relay close proof", async () => {
    const mocks = installBrowserMock();
    mocks.browserSessionSend.mockRejectedValueOnce(new Error("No target with given id found"));
    await connectMockBrowser();

    await expect(
      closeBrowserTargetForUnsafePageExecution({
        cdpUrl: "http://127.0.0.1:18792",
        page: mocks.page,
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("No target with given id found");

    expect(mocks.browserSessionSend.mock.calls).toEqual([
      ["Target.closeTarget", { targetId: "TARGET_1" }],
    ]);
    expect(mocks.browserSessionDetach).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed post-close target list", async () => {
    const mocks = installBrowserMock();
    mocks.browserSessionSend.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({});
    await connectMockBrowser();

    await expect(
      closeBrowserTargetForUnsafePageExecution({
        cdpUrl: "http://127.0.0.1:18792",
        page: mocks.page,
        targetId: "TARGET_1",
      }),
    ).rejects.toThrow("Target.getTargets returned no target list after close");
    expect(mocks.browserSessionDetach).toHaveBeenCalledTimes(1);
  });
});
