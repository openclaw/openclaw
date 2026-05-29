import { describe, expect, it } from "vitest";
import type { BrowserConfig } from "../config/config.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

const VALID_SESSION_ID = "44589bac-33f0-4080-9eff-f1b3e3a0bf9c";

function configWith(overrides: BrowserConfig["profiles"]): BrowserConfig {
  return {
    profiles: overrides,
  } as BrowserConfig;
}

describe("resolveProfile: driver=browserbase", () => {
  it("returns empty cdpUrl and the two new fields when config is valid", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#123456",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
          browserbaseApiKeyEnv: "BROWSERBASE_API_KEY",
        },
      }),
    );
    const profile = resolveProfile(resolved, "bb");
    expect(profile).not.toBeNull();
    expect(profile?.driver).toBe("browserbase");
    expect(profile?.cdpUrl).toBe("");
    expect(profile?.cdpHost).toBe("");
    expect(profile?.cdpIsLoopback).toBe(false);
    expect(profile?.cdpPort).toBe(0);
    expect(profile?.attachOnly).toBe(true);
    expect(profile?.browserbaseSessionId).toBe(VALID_SESSION_ID);
    expect(profile?.browserbaseApiKeyEnv).toBe("BROWSERBASE_API_KEY");
    expect(profile?.color).toBe("#123456");
  });

  it("rejects missing browserbaseSessionId with a clear error", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseApiKeyEnv: "BROWSERBASE_API_KEY",
        },
      }),
    );
    expect(() => resolveProfile(resolved, "bb")).toThrow(/browserbaseSessionId is required/);
  });

  it("rejects missing browserbaseApiKeyEnv with a clear error", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
        },
      }),
    );
    expect(() => resolveProfile(resolved, "bb")).toThrow(/browserbaseApiKeyEnv is required/);
  });

  it("rejects a non-UUID-shaped browserbaseSessionId", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: "not-a-uuid",
          browserbaseApiKeyEnv: "BROWSERBASE_API_KEY",
        },
      }),
    );
    expect(() => resolveProfile(resolved, "bb")).toThrow(/UUID-shaped/);
  });

  it("rejects a lowercase env-var name", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
          browserbaseApiKeyEnv: "browserbase_api_key",
        },
      }),
    );
    expect(() => resolveProfile(resolved, "bb")).toThrow(/UPPER_SNAKE_CASE|A-Z/);
  });

  it("rejects an env-var name that starts with a digit", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
          browserbaseApiKeyEnv: "1_BAD_NAME",
        },
      }),
    );
    expect(() => resolveProfile(resolved, "bb")).toThrow();
  });
});

describe("getBrowserProfileCapabilities: driver=browserbase", () => {
  it("returns mode=remote-cdp + isRemote=true + Playwright-backed + no JSON endpoints", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
          browserbaseApiKeyEnv: "BROWSERBASE_API_KEY",
        },
      }),
    );
    const profile = resolveProfile(resolved, "bb")!;
    const caps = getBrowserProfileCapabilities(profile);
    expect(caps.mode).toBe("remote-cdp");
    expect(caps.isRemote).toBe(true);
    expect(caps.usesPersistentPlaywright).toBe(true);
    expect(caps.usesChromeMcp).toBe(false);
    expect(caps.supportsJsonTabEndpoints).toBe(false);
    expect(caps.supportsReset).toBe(false);
    expect(caps.supportsPerTabWs).toBe(false);
    expect(caps.supportsManagedTabLimit).toBe(false);
  });

  it("differs from the existing-session capability shape", () => {
    const resolved = resolveBrowserConfig(
      configWith({
        bb: {
          color: "#FFFFFF",
          driver: "browserbase",
          browserbaseSessionId: VALID_SESSION_ID,
          browserbaseApiKeyEnv: "BROWSERBASE_API_KEY",
        },
        legacy: {
          color: "#FF0000",
          driver: "existing-session",
        },
      }),
    );
    const bb = resolveProfile(resolved, "bb")!;
    const legacy = resolveProfile(resolved, "legacy")!;
    const bbCaps = getBrowserProfileCapabilities(bb);
    const legacyCaps = getBrowserProfileCapabilities(legacy);
    expect(bbCaps.mode).toBe("remote-cdp");
    expect(legacyCaps.mode).toBe("local-existing-session");
    expect(bbCaps.usesChromeMcp).toBe(false);
    expect(legacyCaps.usesChromeMcp).toBe(true);
  });
});
