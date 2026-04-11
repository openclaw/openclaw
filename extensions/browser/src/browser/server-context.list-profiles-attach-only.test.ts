import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * Issue #64900 — attachOnly loopback profiles (e.g. WSL2 → Windows host via
 * 127.0.0.1) cross a virtual network boundary that adds significant latency.
 * These tests verify that both listProfiles() and ensureBrowserAvailable() use
 * remote-class timeouts for such profiles instead of tight loopback defaults.
 */
describe("attachOnly loopback profile timeout handling (#64900)", () => {
  function makeAttachOnlyState() {
    const profile = makeBrowserProfile({
      name: "remote",
      cdpUrl: "http://127.0.0.1:9222",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPort: 9222,
      color: "#00AA00",
      driver: "openclaw",
      attachOnly: true,
    });
    return makeBrowserServerState({
      profile,
      resolvedOverrides: { defaultProfile: "remote" },
    });
  }

  describe("listProfiles", () => {
    it("uses remoteCdpTimeoutMs for attachOnly loopback profiles", async () => {
      const state = makeAttachOnlyState();
      const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
      isChromeReachable.mockResolvedValue(true);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profiles = await ctx.listProfiles();

      const remote = profiles.find((p) => p.name === "remote");
      expect(remote).toBeDefined();
      expect(remote?.running).toBe(true);

      // Verify the timeout is 1500ms (remoteCdpTimeoutMs) not 200ms
      const calls = isChromeReachable.mock.calls;
      const remoteCall = calls.find((c) => c[0] === "http://127.0.0.1:9222");
      expect(remoteCall).toBeDefined();
      expect(remoteCall![1]).toBe(state.resolved.remoteCdpTimeoutMs);
    });

    it("reports running:false when attachOnly profile is unreachable", async () => {
      const state = makeAttachOnlyState();
      vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profiles = await ctx.listProfiles();

      const remote = profiles.find((p) => p.name === "remote");
      expect(remote).toBeDefined();
      expect(remote?.running).toBe(false);
    });
  });

  describe("ensureBrowserAvailable", () => {
    it("uses remote-class timeouts for HTTP reachability check", async () => {
      const state = makeAttachOnlyState();
      const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
      const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);

      // HTTP reachable, WebSocket also ready
      isChromeReachable.mockResolvedValue(true);
      isChromeCdpReady.mockResolvedValue(true);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profile = ctx.forProfile("remote");
      await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

      // isHttpReachable should use remoteCdpTimeoutMs (1500ms), not
      // PROFILE_HTTP_REACHABILITY_TIMEOUT_MS (300ms)
      expect(isChromeReachable).toHaveBeenCalledWith(
        "http://127.0.0.1:9222",
        state.resolved.remoteCdpTimeoutMs,
        state.resolved.ssrfPolicy,
      );
    });

    it("uses remote-class timeouts for WebSocket readiness check", async () => {
      const state = makeAttachOnlyState();
      const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
      const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);

      isChromeReachable.mockResolvedValue(true);
      isChromeCdpReady.mockResolvedValue(true);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profile = ctx.forProfile("remote");
      await profile.ensureBrowserAvailable();

      // isReachable → isChromeCdpReady should use remote handshake timeout
      expect(isChromeCdpReady).toHaveBeenCalledWith(
        "http://127.0.0.1:9222",
        state.resolved.remoteCdpTimeoutMs,
        state.resolved.remoteCdpHandshakeTimeoutMs,
        state.resolved.ssrfPolicy,
      );
    });

    it("throws BrowserProfileUnavailableError when HTTP is unreachable", async () => {
      const state = makeAttachOnlyState();
      vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);
      vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValue(false);

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profile = ctx.forProfile("remote");
      await expect(profile.ensureBrowserAvailable()).rejects.toThrow(
        /attachOnly.*is not running/,
      );
    });
  });
});
