import { once } from "node:events";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { withConnectedDaemon } from "./extension-relay/relay-coexistence.test-support.js";
import { runBrowserExtensionSetup } from "./extension-setup.js";
import { getFreePort } from "./test-port.js";

// Installation inspection is outside this socket-boundary test and must not read personal Chrome profiles.
vi.mock("./extension-install.js", () => ({
  browserExtensionStatus: async () => ({
    platform: "linux",
    platformSupport: "automatic",
    registrations: [],
    discovered: [],
    storeDiscovered: [],
    storeInstallRequests: [],
  }),
  installChromeExtensionBootstrap: () => {
    throw new Error("Verification must not install");
  },
}));
afterEach(clearRuntimeConfigSnapshot);

it("verifies one authenticated local relay and preserves connected versus no eligible tabs", async () => {
  await withConnectedDaemon(async ({ port, extension, sendTabs }) => {
    const otherPort = await getFreePort();
    const options = {
      action: "verify" as const,
      bundledDir: "/fixture",
      pluginRoot: "/fixture",
      cfg: {
        browser: {
          profiles: {
            chrome: { driver: "extension" as const, cdpPort: port },
            other: { driver: "extension" as const, cdpPort: otherPort },
          },
        },
      },
    };
    const connected = await runBrowserExtensionSetup(options);
    expect(connected).toMatchObject({
      phase: "ready",
      connection: { state: "connected", extensionVersion: "2" },
      target: { profile: "chrome", relayPort: port },
    });
    sendTabs(false);
    expect(await runBrowserExtensionSetup(options)).toMatchObject({
      phase: "ready",
      connection: { state: "connected" },
    });
    const disconnected = once(extension, "close");
    extension.close();
    await disconnected;
    expect(await runBrowserExtensionSetup(options)).toMatchObject({
      connection: { state: "waiting_for_extension" },
    });
    expect(await runBrowserExtensionSetup({ ...options, profile: "other" })).toMatchObject({
      connection: { state: "unavailable" },
      target: { profile: "other", relayPort: otherPort },
    });
  });
});
