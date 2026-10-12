import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as chromeModule from "./chrome.js";
import { ExtensionRelayBridge } from "./extension-relay/relay-bridge.js";
import type { ExtensionRelayHandle } from "./extension-relay/relay-server.js";
import { createBrowserRouteContext } from "./server-context.js";
import { getProfileLifecycle } from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";

const relayMocks = vi.hoisted(() => ({
  ensureExtensionRelayForProfile: vi.fn(),
}));

vi.mock("./extension-relay.runtime.js", () => ({
  getExtensionRelayModule: async () => ({
    ensureExtensionRelayForProfile: relayMocks.ensureExtensionRelayForProfile,
    EXTENSION_PAIRING_HINT: "Pair the browser extension.",
  }),
}));

function createExtensionProfile() {
  const profile = makeBrowserProfile({
    name: "chrome",
    cdpPort: 18799,
    cdpUrl: "http://127.0.0.1:18799",
    driver: "extension",
    attachOnly: true,
  });
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { extensionRelayPorts: { chrome: 18799 } },
  });
  const bridge = new ExtensionRelayBridge();
  const relay = {
    ownership: "owned",
    port: 18799,
    token: "relay-test-key",
    allowLegacyAuth: true,
    internalToken: "relay-test-internal-key",
    bridge,
    close: async () => bridge.dispose(),
  } satisfies ExtensionRelayHandle;
  relayMocks.ensureExtensionRelayForProfile.mockImplementation(
    async (current: BrowserServerState) => {
      current.extensionRelays ??= new Map();
      current.extensionRelays.set("chrome", relay);
      return relay;
    },
  );
  const socket = { send: vi.fn(), close: vi.fn() };
  const extension = bridge.attachExtensionSocket(socket);
  return {
    profile: createBrowserRouteContext({ getState: () => state }).forProfile("chrome"),
    state,
    relay,
    connect: () =>
      extension.onMessage(
        JSON.stringify({
          type: "hello",
          userAgent: "browser-test",
          browserVersion: "Chrome/test",
          extensionVersion: "2",
          tabs: [],
        }),
      ),
    dispose: () => bridge.dispose(),
  };
}

describe("extension profile readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps the actionable pairing error when no extension connects", async () => {
    vi.useFakeTimers();
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

    const browser = createExtensionProfile();
    const unavailable = browser.profile.ensureBrowserAvailable().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_500);

    expect(await unavailable).toEqual(expect.objectContaining({ message: expect.any(String) }));
    expect((await unavailable) as Error).toHaveProperty(
      "message",
      expect.stringContaining("Pair the browser extension."),
    );
    expect(chromeModule.isChromeReachable).not.toHaveBeenCalled();
    browser.dispose();
  });

  it("keeps a sibling attachment wait alive when one request is cancelled", async () => {
    vi.useFakeTimers();
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(true);
    const controller = new AbortController();
    const browser = createExtensionProfile();
    const cancelled = browser.profile
      .ensureBrowserAvailable({ signal: controller.signal })
      .catch((error: unknown) => error);
    const sibling = browser.profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);

    controller.abort(new Error("first browser request cancelled"));
    expect((await cancelled) as Error).toHaveProperty("message", "first browser request cancelled");
    const runtime = browser.state.profiles.get("chrome");
    expect(runtime).toBeDefined();
    if (runtime) {
      expect(getProfileLifecycle(runtime).leases.size).toBe(1);
    }
    expect(browser.state.extensionRelays?.get("chrome")).toBe(browser.relay);
    expect(vi.getTimerCount()).toBe(1);

    browser.connect();
    await expect(sibling).resolves.toBeUndefined();
    if (runtime) {
      expect(getProfileLifecycle(runtime).starts.size).toBe(0);
      expect(getProfileLifecycle(runtime).leases.size).toBe(0);
    }
    expect(browser.relay.bridge.extensionConnected).toBe(true);
    browser.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept readiness from a relay replaced while its request was waiting", async () => {
    vi.useFakeTimers();
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(true);
    const browser = createExtensionProfile();
    const replacement = {
      ...browser.relay,
      internalToken: "replacement-relay-test-key",
      bridge: new ExtensionRelayBridge(),
    } satisfies ExtensionRelayHandle;
    setTimeout(() => {
      browser.state.extensionRelays?.set("chrome", replacement);
      browser.connect();
    }, 100);

    const unavailable = browser.profile.ensureBrowserAvailable().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);

    expect((await unavailable) as Error).toHaveProperty(
      "message",
      expect.stringContaining("Pair the browser extension."),
    );
    expect(chromeModule.isChromeReachable).not.toHaveBeenCalled();
    browser.dispose();
    replacement.bridge.dispose();
  });
});
