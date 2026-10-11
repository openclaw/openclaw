// Browser tests cover config plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserConfig, BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv, withTempDir } from "openclaw/plugin-sdk/test-env";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  getManagedBrowserMissingDisplayError,
  isLocalManagedProfile,
  resolveBrowserConfig,
  resolveManagedBrowserHeadlessMode,
  resolveProfile,
} from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

const BROWSER_HEADLESS_ENV_KEY = "OPENCLAW_BROWSER_HEADLESS";

function resolveRequiredProfile(config: BrowserConfig, profileName: string) {
  const profile = resolveProfile(resolveBrowserConfig(config), profileName);
  if (!profile) {
    throw new Error(`Expected resolved browser profile ${profileName}`);
  }
  return profile;
}

function withProfile(
  name: string,
  profile: BrowserProfileConfig,
  root: Omit<BrowserConfig, "profiles"> = {},
): BrowserConfig {
  return { ...root, profiles: { [name]: { color: "#FF4500", ...profile } } };
}

describe("browser config", () => {
  it.each(["chromium"] as const)(
    "rejects Lightpanda endpoint aliases in unvalidated runtime config (%s)",
    (engine) => {
      expect(() =>
        resolveBrowserConfig({
          profiles: {
            lightweight: {
              engine: "lightpanda",
              cdpUrl: "ws://127.0.0.1:9222/",
              attachOnly: true,
            },
            alias: { engine, cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
          },
        }),
      ).toThrow(/dedicated CDP endpoint/);
    },
  );

  it.each(["wss://browser.example/cdp"])(
    "resolves Lightpanda as a persistent, externally owned semantic browser: %s",
    (cdpUrl) => {
      const profile = resolveRequiredProfile(
        withProfile(
          "lightweight",
          { engine: "lightpanda", cdpUrl, attachOnly: true },
          { headless: false, executablePath: "/usr/bin/chromium", attachOnly: false },
        ),
        "lightweight",
      );
      expect(profile).toMatchObject({
        engine: "lightpanda",
        cdpUrl,
        attachOnly: true,
        headless: true,
        driver: "openclaw",
      });
      expect(profile.executablePath).toBeUndefined();
      expect(isLocalManagedProfile(profile)).toBe(false);
      expect(getBrowserProfileCapabilities(profile)).toMatchObject({
        mode: "lightweight-cdp",
        browserFilesystemLocal: false,
        usesPersistentPlaywright: true,
        supportsJsonTabEndpoints: false,
        supportsPerTabWs: false,
        supportsMultipleTabs: false,
        supportsPageText: true,
        supportsScreenshots: false,
        supportsVisualActions: false,
        supportsDownloads: false,
        supportsPdf: false,
        supportsUploads: false,
        supportsDialogs: false,
        supportsStorage: false,
        supportsScreencast: false,
        supportsConsole: false,
        supportsBatchActions: false,
        supportsRequests: false,
        supportsErrors: false,
        supportsEmulation: false,
      });
    },
  );

  it.each<Partial<BrowserProfileConfig>>([
    { cdpUrl: undefined },
    { attachOnly: undefined },
    { driver: "extension" },
    { userDataDir: "/tmp/chrome-profile" },
  ])("rejects incompatible Lightpanda runtime config without schema validation: %j", (invalid) => {
    expect(() =>
      resolveRequiredProfile(
        withProfile("lightweight", {
          engine: "lightpanda",
          cdpUrl: "ws://127.0.0.1:9222/",
          attachOnly: true,
          ...invalid,
        }),
        "lightweight",
      ),
    ).toThrow(/Lightpanda/);
  });

  it("fills defaults without changing caller-owned profiles or prototype-like names", () => {
    const selected = Object.freeze({ driver: "existing-session" as const, attachOnly: true });
    const profiles = Object.freeze({
      ["__proto__"]: Object.freeze({ cdpPort: 18802 }),
      constructor: Object.freeze({ cdpPort: 18803 }),
      user: selected,
    });
    const resolved = resolveBrowserConfig(
      Object.freeze({ profiles, defaultProfile: "user", cdpUrl: "http://127.0.0.1:9222/" }),
    );

    expect(Object.keys(profiles)).toEqual(["__proto__", "constructor", "user"]);
    expect(selected).not.toHaveProperty("cdpUrl");
    expect(Object.keys(resolved.profiles)).toEqual([
      "__proto__",
      "constructor",
      "user",
      "openclaw",
      "chrome",
    ]);
    expect(Object.getPrototypeOf(resolved.profiles)).toBe(Object.prototype);
    expect(resolveProfile(resolved, "__proto__")?.cdpPort).toBe(18802);
    expect(resolveProfile(resolved, "constructor")?.cdpPort).toBe(18803);
    expect(resolveProfile(resolved, "user")?.cdpUrl).toBe("http://127.0.0.1:9222");
  });

  it("keeps literal $ patterns in home when expanding a tilde executable path", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveBrowserConfig({ executablePath: "~/chrome-bin" }).executablePath).toBe(
        path.resolve("/home/$&user/chrome-bin"),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not assign an implicit extension relay an explicitly pinned managed port", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        pinned: { cdpPort: 18799, color: "#00AA00" },
      },
    });

    expect(resolveProfile(resolved, "pinned")?.cdpPort).toBe(18799);
    expect(resolveProfile(resolved, "chrome")?.cdpPort).toBe(18798);
  });

  it.each([
    {
      label: "existing-session",
      pinned: { driver: "existing-session" as const, cdpUrl: "http://127.0.0.1:18799" },
    },
  ])("does not assign an implicit extension relay a $label profile's cdpUrl port", ({ pinned }) => {
    const resolved = resolveBrowserConfig({
      profiles: { pinned: { ...pinned, color: "#00AA00" } },
    });

    expect(resolveProfile(resolved, "chrome")?.cdpPort).toBe(18798);
  });

  it("rejects implicit extension relays that exhaust the reserved port band", () => {
    const profiles: NonNullable<BrowserConfig["profiles"]> = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `extension-${index}`,
        { driver: "extension" as const, color: "#00AA00" },
      ]),
    );

    expect(() => resolveBrowserConfig({ profiles })).toThrow(/extension.*relay.*port/i);
  });

  it("normalizes config without reading or rewriting the relay secret", async () => {
    const content = `${"a1".repeat(32)}\n`;
    await withTempDir("openclaw-config-relay-", async (dir) => {
      const stateDir = fs.realpathSync(dir);
      const credentials = path.join(stateDir, "credentials");
      fs.mkdirSync(credentials, { mode: 0o700 });
      const secretPath = path.join(credentials, "browser-extension-relay.secret");
      withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials }, () => {
        const withoutSecret = resolveBrowserConfig(undefined);
        fs.writeFileSync(secretPath, content, { flag: "wx", mode: 0o600 });
        expect(resolveBrowserConfig(undefined)).toEqual(withoutSecret);
        expect(fs.readFileSync(secretPath, "utf8")).toBe(content);
      });
    });
  });

  it("keeps the lifecycle's host-local relay key out of the extension cdpUrl", () => {
    const resolved = resolveBrowserConfig(undefined);
    resolved.extensionRelayToken = "a1".repeat(32);
    const chrome = resolveProfile(resolved, "chrome");
    expect(chrome?.cdpUrl).toBe(`http://127.0.0.1:${resolved.extensionRelayDefaultPort}`);

    resolved.extensionRelayInternalTokens.chrome = "process-only-token";
    expect(resolveProfile(resolved, "chrome")?.cdpUrl).toBe(
      [
        "http://openclaw-internal:",
        "process-only-token",
        `@127.0.0.1:${resolved.extensionRelayDefaultPort}`,
      ].join(""),
    );
  });

  it("allows legacy extension relay auth for one migration window by default", () => {
    expect(resolveBrowserConfig(undefined).extensionRelay.allowLegacyAuth).toBe(true);
    expect(
      resolveBrowserConfig({ extensionRelay: { allowLegacyAuth: false } }).extensionRelay
        .allowLegacyAuth,
    ).toBe(false);
  });

  // Windows-only: on POSIX path.resolve treats `\` as a literal character,
  // so "~\foo" cannot resolve to "$HOME/foo". The helper's regex still matches
  // a leading `~\` on every platform; we only assert the resolved form where
  // the OS path module agrees.
  (process.platform === "win32" ? it : it.skip)(
    "expands a Windows-style ~\\ executablePath to the OS home directory",
    () => {
      const resolved = resolveBrowserConfig({
        executablePath: "~\\AppData\\Local\\Chromium\\chrome.exe",
      });

      expect(resolved.executablePath).toBe(
        path.resolve(os.homedir(), "AppData/Local/Chromium/chrome.exe"),
      );
    },
  );

  it.each([
    {
      name: "inherits executablePath from global browser config when profile override is not set",
      root: { executablePath: "~/bin/chrome-global" },
      profile: {},
      expected: { executablePath: path.resolve(os.homedir(), "bin/chrome-global") },
    },
  ])("$name", ({ root, profile, expected }) => {
    expect(
      resolveRequiredProfile(
        {
          ...root,
          profiles: {
            remote: { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC", ...profile },
          },
        },
        "remote",
      ),
    ).toMatchObject(expected);
  });

  describe("managed browser headless mode", () => {
    const noDisplayEnv = {
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      [BROWSER_HEADLESS_ENV_KEY]: undefined,
    };

    it.each([
      {
        name: "does not apply the no-display fallback to remote CDP profiles",
        config: withProfile("remote", { cdpUrl: "http://10.0.0.42:9222" }),
        profileName: "remote",
        expected: { headless: false, source: "default" },
      },
      {
        name: "lets OPENCLAW_BROWSER_HEADLESS override profile/global config",
        config: withProfile("openclaw", { cdpPort: 18800, headless: false }),
        profileName: "openclaw",
        headlessEnv: "1",
        expected: { headless: true, source: "env" },
      },
    ])("$name", ({ config, profileName, headlessEnv, expected }) => {
      const resolved = resolveBrowserConfig(config);
      const profile = resolveProfile(resolved, profileName)!;
      expect(
        resolveManagedBrowserHeadlessMode(resolved, profile, {
          platform: "linux",
          env: { ...noDisplayEnv, [BROWSER_HEADLESS_ENV_KEY]: headlessEnv },
        }),
      ).toEqual(expected);
    });

    it("returns an actionable error only when headed mode is explicitly selected", () => {
      const defaultResolved = resolveBrowserConfig({});
      const defaultProfile = resolveProfile(defaultResolved, "openclaw")!;
      expect(
        getManagedBrowserMissingDisplayError(defaultResolved, defaultProfile, {
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toBeNull();

      const profileResolved = resolveBrowserConfig({
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500", headless: false },
        },
      });
      const profile = resolveProfile(profileResolved, "openclaw")!;
      expect(
        getManagedBrowserMissingDisplayError(profileResolved, profile, {
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toMatchObject({
        message: expect.stringContaining("browser.profiles.openclaw.headless=false"),
        headlessSource: "profile",
      });

      expect(
        getManagedBrowserMissingDisplayError(defaultResolved, defaultProfile, {
          headlessOverride: false,
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toMatchObject({
        message: expect.stringContaining("request override"),
        headlessSource: "request",
      });
    });
  });

  it.each([
    {
      name: "uses base protocol for profiles with only cdpPort",
      config: withProfile("work", { cdpPort: 18801 }, { cdpUrl: "https://example.com:9443" }),
      profileName: "work",
      expected: { cdpUrl: "https://example.com:18801" },
    },
    {
      name: "preserves wss:// cdpUrl with query params for the default profile",
      config: { cdpUrl: "wss://connect.browserbase.com?apiKey=test-key" },
      profileName: "openclaw",
      expected: {
        cdpUrl: "wss://connect.browserbase.com/?apiKey=test-key",
        cdpHost: "connect.browserbase.com",
        cdpPort: 443,
        cdpIsLoopback: false,
      },
    },
    {
      name: "URL without port and no cdpPort falls back to protocol default",
      config: withProfile("openclaw", { cdpUrl: "https://remote-browser.example.com" }),
      profileName: "openclaw",
      expected: { cdpPort: 443, cdpUrl: "https://remote-browser.example.com" },
    },
    {
      name: "stale WS devtools URL + cdpPort drops path and uses cdpPort",
      config: withProfile("chrome-cdp", {
        cdpPort: 9222,
        cdpUrl: "ws://127.0.0.1:12345/devtools/browser/old-stale-id",
        attachOnly: true,
      }),
      profileName: "chrome-cdp",
      expected: {
        cdpUrl: "http://127.0.0.1:9222",
        cdpPort: 9222,
        cdpIsLoopback: true,
        attachOnly: true,
      },
    },
  ])("$name", ({ config, profileName, expected }) => {
    expect(resolveRequiredProfile(config, profileName)).toMatchObject(expected);
  });

  it("rejects openclaw profiles without cdpPort or cdpUrl", () => {
    const resolved = resolveBrowserConfig(withProfile("bad", { driver: "openclaw" }));
    expect(() => resolveProfile(resolved, "bad")).toThrow("must define cdpPort or cdpUrl");
  });

  it.each([
    {
      name: "filters out non-string entries from extraArgs",
      config: {
        extraArgs: ["--flag", 42, null, undefined, true, "--other"] as unknown as string[],
      },
      expected: ["--flag", "--other"],
    },
  ] as Array<{ name: string; config: BrowserConfig | undefined; expected: string[] }>)(
    "$name",
    ({ config, expected }) => {
      expect(resolveBrowserConfig(config).extraArgs).toStrictEqual(expected);
    },
  );

  it.each([
    {
      name: "resolves browser SSRF policy when configured",
      config: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          allowedHostnames: [" localhost ", " *.trusted.example ", ""],
        },
      },
      expected: {
        dangerouslyAllowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        allowedHostnames: ["localhost", "*.trusted.example"],
      },
    },
    {
      name: "keeps configured profile cdpUrls out of the shared browser SSRF policy",
      config: withProfile("remote", {
        color: "#123456",
        cdpUrl: "http://172.29.128.1:9223",
      }),
      expected: {},
    },
  ])("$name", ({ config, expected }) => {
    expect(resolveBrowserConfig(config).ssrfPolicy).toStrictEqual(expected);
  });

  it.each([
    {
      name: "expands tilde-prefixed userDataDir for existing-session profiles",
      config: withProfile("brave", {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      }),
      profileName: "brave",
      expected: {
        driver: "existing-session",
        userDataDir: resolveUserPath("~/Library/Application Support/BraveSoftware/Brave-Browser"),
      },
    },
    {
      name: "resolves Chrome MCP command, args, and endpoint URL for existing-session profiles",
      config: withProfile("chrome-live", {
        driver: "existing-session",
        attachOnly: true,
        cdpUrl: "http://127.0.0.1:9222/",
        mcpCommand: " /usr/local/bin/chrome-devtools-mcp ",
        mcpArgs: ["--no-usage-statistics", " ", "--performanceCrux", "false"],
        color: "#00AA00",
      }),
      profileName: "chrome-live",
      expected: {
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        mcpCommand: "/usr/local/bin/chrome-devtools-mcp",
        mcpArgs: ["--no-usage-statistics", "--performanceCrux", "false"],
      },
    },
    {
      name: "preserves direct websocket cdpUrl for existing-session profiles",
      config: withProfile("chrome-live", {
        driver: "existing-session",
        attachOnly: true,
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        color: "#00AA00",
      }),
      profileName: "chrome-live",
      expected: {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
      },
    },
  ] as Array<{
    name: string;
    config: BrowserConfig;
    profileName: string;
    exact?: boolean;
    expectedDefaultProfile?: string;
    expected: Record<string, unknown>;
  }>)("$name", ({ config, profileName, exact, expectedDefaultProfile, expected }) => {
    const resolved = resolveBrowserConfig(config);
    if (expectedDefaultProfile) {
      expect(resolved.defaultProfile).toBe(expectedDefaultProfile);
    }
    const profile = resolveProfile(resolved, profileName);
    if (exact) {
      expect(profile).toStrictEqual(expected);
    } else {
      expect(profile).toMatchObject(expected);
    }
  });
});
