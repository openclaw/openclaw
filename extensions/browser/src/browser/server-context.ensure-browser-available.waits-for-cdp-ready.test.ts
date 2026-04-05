import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import {
  PROFILE_ATTACH_RETRY_TIMEOUT_MS,
  PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState, mockLaunchedChrome } from "./server-context.test-harness.js";

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();

  const launchMullusiChrome = vi.mocked(chromeModule.launchMullusiChrome);
  const stopMullusiChrome = vi.mocked(chromeModule.stopMullusiChrome);
  const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
  const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
  isChromeReachable.mockResolvedValue(false);

  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("mullusi");

  return { launchMullusiChrome, stopMullusiChrome, isChromeCdpReady, profile };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("waits for CDP readiness after launching to avoid follow-up PortInUseError races (#21149)", async () => {
    const { launchMullusiChrome, stopMullusiChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockLaunchedChrome(launchMullusiChrome, 123);

    const promise = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();

    expect(launchMullusiChrome).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalled();
    expect(stopMullusiChrome).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { launchMullusiChrome, stopMullusiChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(false);
    mockLaunchedChrome(launchMullusiChrome, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    await vi.advanceTimersByTimeAsync(8100);
    await rejected;

    expect(launchMullusiChrome).toHaveBeenCalledTimes(1);
    expect(stopMullusiChrome).toHaveBeenCalledTimes(1);
  });

  it("reuses a pre-existing loopback browser after an initial short probe miss", async () => {
    const { launchMullusiChrome, stopMullusiChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);

    isChromeReachable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:18800",
      PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      {
        allowPrivateNetwork: true,
      },
    );
    expect(isChromeReachable).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:18800",
      PROFILE_ATTACH_RETRY_TIMEOUT_MS,
      {
        allowPrivateNetwork: true,
      },
    );
    expect(launchMullusiChrome).not.toHaveBeenCalled();
    expect(stopMullusiChrome).not.toHaveBeenCalled();
  });
});
