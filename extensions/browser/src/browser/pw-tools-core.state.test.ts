import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "./pw-session-contracts.js";

const stateMocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(),
  getPageForTargetId: vi.fn(),
  devices: {
    "iPhone 14": {
      userAgent: "iphone-14-user-agent",
      viewport: { width: 750, height: 340 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: "webkit",
    },
    "Desktop Chrome": {
      userAgent: "desktop-chrome-user-agent",
      viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      defaultBrowserType: "chromium",
    },
  },
}));

vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightCore: () => ({ devices: stateMocks.devices }),
}));

vi.mock("./pw-session.js", () => ({
  ensurePageState: stateMocks.ensurePageState,
  getPageForTargetId: stateMocks.getPageForTargetId,
}));

import {
  setDeviceViaPlaywright,
  setGeolocationViaPlaywright,
  setLocaleViaPlaywright,
  setTimezoneViaPlaywright,
} from "./pw-tools-core.state.js";

function createPage() {
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}));
  const detach = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => ({ send, detach }));
  let viewport: { width: number; height: number } | null = null;
  const setViewportSize = vi.fn(async (value: { width: number; height: number }) => {
    viewport = value;
  });
  const page = {
    context: () => ({ newCDPSession }),
    setViewportSize,
    viewportSize: () => viewport,
  };
  return { page, send, detach, newCDPSession, setViewportSize };
}

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };

describe("setDeviceViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMocks.ensurePageState.mockReturnValue({});
  });

  it("keeps one page-scoped CDP session attached for persistent emulation", async () => {
    const fixture = createPage();
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    await setTimezoneViaPlaywright({
      ...target,
      timezoneId: "America/New_York",
    });
    await setLocaleViaPlaywright({
      ...target,
      locale: "en-GB",
    });

    expect(fixture.newCDPSession).toHaveBeenCalledTimes(1);
    expect(fixture.detach).not.toHaveBeenCalled();
    expect(fixture.send.mock.calls).toEqual([
      ["Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }],
      ["Emulation.setLocaleOverride", { locale: "en-GB" }],
    ]);
  });

  it("keeps the successful Playwright viewport when a later device override fails", async () => {
    const fixture = createPage();
    const state: Partial<PageState> = {};
    stateMocks.ensurePageState.mockReturnValue(state);
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);
    await setDeviceViaPlaywright({ ...target, name: "iPhone 14" });
    fixture.send.mockImplementation(async (method) => {
      if (method === "Emulation.setDeviceMetricsOverride") {
        throw new Error("metrics override failed");
      }
      return {};
    });

    await expect(setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" })).rejects.toThrow(
      "metrics override failed",
    );

    expect(fixture.page.viewportSize()).toEqual({ width: 1280, height: 720 });
    expect(state.emulation?.metricsOwner).toBeUndefined();
    expect(state.emulation?.touch?.enabled).toBe(true);
  });

  it("serializes overlapping descriptor transitions on the same page", async () => {
    let releaseFirstUserAgent!: () => void;
    const firstUserAgentBlocked = new Promise<void>((resolve) => {
      releaseFirstUserAgent = resolve;
    });
    const fixture = createPage();
    fixture.send.mockImplementation(async (method, params) => {
      if (
        method === "Emulation.setUserAgentOverride" &&
        params?.userAgent === "iphone-14-user-agent"
      ) {
        await firstUserAgentBlocked;
      }
      return {};
    });
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    const phone = setDeviceViaPlaywright({
      ...target,
      name: "iPhone 14",
    });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
    const desktop = setDeviceViaPlaywright({
      ...target,
      name: "Desktop Chrome",
    });

    await Promise.resolve();
    const viewportCallsWhileFirstDescriptorBlocked = fixture.setViewportSize.mock.calls.length;
    const cdpCallsWhileFirstDescriptorBlocked = fixture.send.mock.calls.length;

    releaseFirstUserAgent();
    await Promise.all([phone, desktop]);
    expect(viewportCallsWhileFirstDescriptorBlocked).toBe(1);
    expect(cdpCallsWhileFirstDescriptorBlocked).toBe(1);
    expect(fixture.setViewportSize.mock.calls).toEqual([
      [{ width: 750, height: 340 }],
      [{ width: 1280, height: 720 }],
    ]);
    expect(fixture.send).toHaveBeenNthCalledWith(1, "Emulation.setUserAgentOverride", {
      userAgent: "iphone-14-user-agent",
    });
    expect(fixture.send).toHaveBeenNthCalledWith(3, "Emulation.setTouchEmulationEnabled", {
      enabled: true,
    });
    expect(fixture.send).toHaveBeenNthCalledWith(5, "Emulation.setUserAgentOverride", {
      userAgent: "desktop-chrome-user-agent",
    });
    expect(fixture.send).toHaveBeenNthCalledWith(2, "Emulation.setDeviceMetricsOverride", {
      mobile: true,
      width: 750,
      height: 340,
      deviceScaleFactor: 3,
      screenWidth: 390,
      screenHeight: 844,
      screenOrientation: { angle: 0, type: "portraitPrimary" },
    });
    expect(fixture.send).toHaveBeenNthCalledWith(6, "Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      screenWidth: 1920,
      screenHeight: 1080,
      screenOrientation: { angle: 0, type: "landscapePrimary" },
    });
    expect(fixture.send).toHaveBeenNthCalledWith(7, "Emulation.setTouchEmulationEnabled", {
      enabled: false,
    });
    expect(fixture.newCDPSession).toHaveBeenCalledTimes(1);
    expect(fixture.detach).not.toHaveBeenCalled();
    expect(fixture.send.mock.calls.map(([method]) => method)).toEqual([
      "Emulation.setUserAgentOverride",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setUserAgentOverride",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
  });
});

describe("setGeolocationViaPlaywright", () => {
  it.each(["before", "after"] as const)(
    "settles geolocation clear cleanup when authority is revoked %s admission",
    async (revoked) => {
      let current = revoked !== "before";
      const setGeolocation = vi.fn(async () => {
        current = false;
      });
      const clearPermissions = vi.fn(async () => {});
      stateMocks.ensurePageState.mockReturnValue({});
      stateMocks.getPageForTargetId.mockResolvedValue({
        context: () => ({ setGeolocation, clearPermissions }),
      });
      const clearing = setGeolocationViaPlaywright({
        ...target,
        clear: true,
        assertCurrent: async () => {
          if (!current) {
            throw new Error("dashboard owner stopped");
          }
        },
      });
      if (revoked === "before") {
        await expect(clearing).rejects.toThrow("dashboard owner stopped");
        expect(setGeolocation).not.toHaveBeenCalled();
        expect(clearPermissions).not.toHaveBeenCalled();
      } else {
        await expect(clearing).resolves.toBeUndefined();
        expect(setGeolocation).toHaveBeenCalledExactlyOnceWith(null);
        expect(clearPermissions).toHaveBeenCalledOnce();
      }
    },
  );
});
