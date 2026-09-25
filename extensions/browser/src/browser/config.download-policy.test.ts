import type { BrowserConfig, BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

function resolveProfileFor(name: string, profile: BrowserProfileConfig, owned = false) {
  const resolved = resolveBrowserConfig({ profiles: { [name]: profile } } satisfies BrowserConfig);
  if (owned) {
    resolved.openClawLaunchedProfileNames = [name];
  }
  const result = resolveProfile(resolved, name);
  if (!result) {
    throw new Error(`Expected resolved browser profile ${name}`);
  }
  return result;
}

describe("browser download policy profile resolution", () => {
  it.each(["mcpCommand", "mcpArgs"] as const)(
    "rejects reset when Chrome MCP is configured with %s",
    (key) => {
      const profile: BrowserProfileConfig = {
        driver: "openclaw",
        cdpUrl: "http://127.0.0.1:9222",
        attachOnly: true,
        resetDefaultDownloadBehaviorOnAttach: true,
        ...(key === "mcpCommand" ? { mcpCommand: "chrome-devtools-mcp" } : { mcpArgs: [] }),
      };
      expect(() => resolveProfileFor("remote", profile)).toThrow(
        /requires an OpenClaw Chromium profile using the Playwright CDP driver/,
      );
    },
  );

  it("preserves Playwright download capture for OpenClaw-launched attach-only Chromium", () => {
    const profile = resolveProfileFor(
      "owned",
      { driver: "openclaw", cdpUrl: "http://127.0.0.1:9222", attachOnly: true },
      true,
    );
    expect(profile.noDefaults).toBeUndefined();
    expect(getBrowserProfileCapabilities(profile).supportsDownloads).toBe(true);
  });

  it("preserves Playwright download capture for extension-relay profiles", () => {
    const profile = resolveProfileFor("chrome", { driver: "extension" });
    expect(profile.noDefaults).toBeUndefined();
    expect(getBrowserProfileCapabilities(profile).supportsDownloads).toBe(true);
  });

  it("rejects recovery for a managed profile that does not attach", () => {
    expect(() =>
      resolveProfileFor("managed", {
        driver: "openclaw",
        cdpPort: 9222,
        attachOnly: false,
        resetDefaultDownloadBehaviorOnAttach: true,
      }),
    ).toThrow(/requires an OpenClaw Chromium profile using the Playwright CDP driver/);
  });

  it("preserves external policy and reports event-based capture unavailable", () => {
    const profile = resolveProfileFor("remote", {
      driver: "openclaw",
      cdpUrl: "http://127.0.0.1:9222",
      attachOnly: true,
    });
    expect(profile.noDefaults).toBe(true);
    expect(getBrowserProfileCapabilities(profile).supportsDownloads).toBe(false);
  });
});
