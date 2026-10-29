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
  it.each(["chromium", "lightpanda"] as const)(
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

  it.each(["ws://127.0.0.1:9222/", "ws://lightpanda:9222/", "wss://browser.example/cdp"])(
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
        supportsPerTabWs: false,
        supportsPageText: true,
        supportsScreenshots: false,
        supportsVisualActions: false,
        supportsDownloads: false,
        supportsPdf: false,
        supportsUploads: false,
        supportsDialogs: false,
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
    { cdpUrl: "http://127.0.0.1:9222" },
    { cdpUrl: "not-a-url" },
    { attachOnly: undefined },
    { attachOnly: false },
    { driver: "existing-session" },
    { driver: "extension" },
    { cdpPort: 9222 },
    { userDataDir: "/tmp/chrome-profile" },
    { mcpCommand: "chrome-devtools-mcp" },
    { mcpArgs: [] },
    { executablePath: "/usr/bin/chromium" },
    { headless: false },
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

  it("defaults to enabled with loopback defaults and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved).toMatchObject({
      enabled: true,
      controlPort: 18791,
      color: "#FF4500",
      cdpHost: "127.0.0.1",
      cdpProtocol: "http",
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      actionTimeoutMs: 60_000,
      localLaunchTimeoutMs: 60_000,
      localCdpReadyTimeoutMs: 30_000,
    });
    expect(resolved.tabCleanup).toEqual({
      enabled: true,
      idleMinutes: 120,
      maxTabsPerSession: 8,
      sweepMinutes: 5,
    });
    expect(resolveProfile(resolved, resolved.defaultProfile)).toMatchObject({
      name: "openclaw",
      driver: "openclaw",
      engine: "chromium",
      cdpPort: 18800,
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(resolveProfile(resolved, "user")).toMatchObject({
      driver: "existing-session",
      cdpPort: 0,
      cdpUrl: "",
      userDataDir: undefined,
    });
    expect(resolveProfile(resolved, "chrome-relay")).toBe(null);
  });

  it("provides a built-in chrome extension-relay profile with a derived loopback port", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.extensionRelayDefaultPort).toBe(resolved.controlPort + 8);
    expect(resolveProfile(resolved, "chrome")).toMatchObject({
      driver: "extension",
      attachOnly: true,
      cdpPort: resolved.extensionRelayDefaultPort,
      cdpUrl: `http://127.0.0.1:${resolved.extensionRelayDefaultPort}`,
      cdpIsLoopback: true,
    });
  });

  it("assigns distinct relay ports to multiple extension profiles", () => {
    const resolved = resolveBrowserConfig(withProfile("work", { driver: "extension" }));
    const chrome = resolveProfile(resolved, "chrome");
    const work = resolveProfile(resolved, "work");
    expect(chrome?.cdpPort).not.toBe(work?.cdpPort);
    expect(Math.max(chrome?.cdpPort ?? 0, work?.cdpPort ?? 0)).toBe(
      resolved.extensionRelayDefaultPort,
    );
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

  it.each(["extension", "openclaw"] as const)(
    "reserves explicit %s ports before relay allocation",
    (driver) => {
      const resolved = resolveBrowserConfig(withProfile("pinned", { driver, cdpPort: 18799 }));
      expect(resolveProfile(resolved, "pinned")?.cdpPort).toBe(18799);
      expect(resolveProfile(resolved, "chrome")?.cdpPort).toBe(18798);
    },
  );

  it.each([
    { label: "managed", pinned: { cdpUrl: "http://127.0.0.1:18799", attachOnly: true } },
    {
      label: "existing-session",
      pinned: { driver: "existing-session" as const, cdpUrl: "http://127.0.0.1:18799" },
    },
  ])("does not assign an implicit extension relay a $label profile's cdpUrl port", ({ pinned }) => {
    const resolved = resolveBrowserConfig(withProfile("pinned", pinned));

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
      `http://openclaw-internal:process-only-token@127.0.0.1:${resolved.extensionRelayDefaultPort}`,
    );
  });

  it("allows legacy extension relay auth for one migration window by default", () => {
    expect(resolveBrowserConfig(undefined).extensionRelay.allowLegacyAuth).toBe(true);
    expect(
      resolveBrowserConfig({ extensionRelay: { allowLegacyAuth: false } }).extensionRelay
        .allowLegacyAuth,
    ).toBe(false);
  });

  it.each([
    ["19001", undefined, 19003, 19012],
    [undefined, 19011, 19013, 19022],
  ] as const)("derives ports from env=%s gateway.port=%s", (env, port, controlPort, cdpPort) => {
    withEnv({ OPENCLAW_GATEWAY_PORT: env }, () => {
      const resolved = resolveBrowserConfig(undefined, { gateway: { port } });
      expect(resolved.controlPort).toBe(controlPort);
      expect(resolveProfile(resolved, "chrome-relay")).toBe(null);
      expect(resolveProfile(resolved, "openclaw")).toMatchObject({
        cdpPort,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
      });
    });
  });

  it.each([
    [" ~/.local/bin/chromium ", path.resolve(os.homedir(), ".local/bin/chromium")],
    ["   ", undefined],
    ["~", path.resolve(os.homedir())],
    [" /opt/~chromium/chrome ", "/opt/~chromium/chrome"],
  ])("normalizes executablePath %j", (input, expected) => {
    expect(resolveBrowserConfig({ executablePath: input }).executablePath).toBe(expected);
  });

  // POSIX path.resolve treats backslashes literally.
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

  it("supports explicit CDP URLs for the default profile", () => {
    expect(resolveRequiredProfile({ cdpUrl: "http://example.com:9222" }, "openclaw")).toMatchObject(
      {
        cdpPort: 9222,
        cdpUrl: "http://example.com:9222",
        cdpIsLoopback: false,
      },
    );
  });

  it("uses profile cdpUrl when provided", () => {
    expect(
      resolveRequiredProfile(withProfile("remote", { cdpUrl: "http://10.0.0.42:9222" }), "remote"),
    ).toMatchObject({
      cdpUrl: "http://10.0.0.42:9222",
      cdpHost: "10.0.0.42",
      cdpIsLoopback: false,
    });
  });

  it.each<[BrowserConfig, BrowserProfileConfig, Partial<BrowserProfileConfig>]>([
    [{ attachOnly: true }, {}, { attachOnly: true }],
    [{ attachOnly: false }, { attachOnly: true }, { attachOnly: true }],
    [{ headless: true }, {}, { headless: true }],
    [{ headless: false }, { headless: true }, { headless: true }],
    [{ headless: true }, { headless: false }, { headless: false }],
    [
      { executablePath: "~/bin/chrome-global" },
      {},
      { executablePath: path.resolve(os.homedir(), "bin/chrome-global") },
    ],
    [
      { executablePath: "/usr/bin/chrome-global" },
      { executablePath: " ~/bin/chrome-profile " },
      { executablePath: path.resolve(os.homedir(), "bin/chrome-profile") },
    ],
    [
      { executablePath: "/usr/bin/chrome-global" },
      { executablePath: "   " },
      { executablePath: "/usr/bin/chrome-global" },
    ],
  ])("resolves root %j and profile override %j", (root, profile, expected) => {
    expect(
      resolveRequiredProfile(
        withProfile("remote", { cdpUrl: "http://127.0.0.1:9222", ...profile }, root),
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

    it.each<[BrowserConfig, string, boolean, string, string?, boolean?]>([
      [{}, "openclaw", true, "default"],
      [withProfile("remote", { cdpUrl: "http://10.0.0.42:9222" }), "remote", false, "default"],
      [
        withProfile("openclaw", { cdpPort: 18800, headless: false }, { headless: true }),
        "openclaw",
        false,
        "profile",
      ],
      [{ headless: false }, "openclaw", false, "config"],
      [withProfile("openclaw", { cdpPort: 18800, headless: false }), "openclaw", true, "env", "1"],
      [
        withProfile("openclaw", { cdpPort: 18800, headless: false }, { headless: false }),
        "openclaw",
        true,
        "request",
        "0",
        true,
      ],
    ])(
      "resolves headless config %j profile %s via %s/%s",
      (config, profileName, headless, source, headlessEnv, headlessOverride) => {
        const resolved = resolveBrowserConfig(config);
        const profile = resolveProfile(resolved, profileName)!;
        expect(
          resolveManagedBrowserHeadlessMode(resolved, profile, {
            headlessOverride,
            platform: "linux",
            env: { ...noDisplayEnv, [BROWSER_HEADLESS_ENV_KEY]: headlessEnv },
          }),
        ).toEqual({ headless, source });
      },
    );

    it("returns an actionable error only when headed mode is explicitly selected", () => {
      const defaultResolved = resolveBrowserConfig({});
      const defaultProfile = resolveProfile(defaultResolved, "openclaw")!;
      expect(
        getManagedBrowserMissingDisplayError(defaultResolved, defaultProfile, {
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toBeNull();

      const profileResolved = resolveBrowserConfig(
        withProfile("openclaw", { cdpPort: 18800, headless: false }),
      );
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
      name: "preserves loopback direct WebSocket cdpUrl for explicit profiles",
      config: withProfile("localws", {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
      }),
      profileName: "localws",
      expected: {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        cdpPort: 9222,
        cdpIsLoopback: true,
      },
    },
    {
      name: "URL with non-default port wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1:9222" }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://127.0.0.1:9222" },
    },
    {
      name: "URL with explicit default port :80 wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1:80" }),
      profileName: "openclaw",
      expected: { cdpPort: 80, cdpUrl: "http://127.0.0.1:80" },
    },
    {
      name: "URL without port defers to cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1" }),
      profileName: "openclaw",
      expected: { cdpPort: 18800, cdpUrl: "http://127.0.0.1:18800" },
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
    {
      name: "IPv6 URL without port defers to cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://[::1]" }),
      profileName: "openclaw",
      expected: { cdpPort: 18800, cdpUrl: "http://[::1]:18800" },
    },
    {
      name: "IPv6 URL with explicit port wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://[::1]:9222" }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://[::1]:9222" },
    },
    {
      name: "preserves profile host when dropping stale devtools WS path",
      config: withProfile(
        "chrome-local",
        { cdpPort: 9222, cdpUrl: "ws://10.0.0.42:9222/devtools/browser/stale-id" },
        { cdpUrl: "http://devbox.local:9000" },
      ),
      profileName: "chrome-local",
      // The profile WS URL owns the host even when a global cdpUrl is configured.
      expected: {
        cdpUrl: "http://10.0.0.42:9222",
        cdpHost: "10.0.0.42",
        cdpIsLoopback: false,
      },
    },
  ])("$name", ({ config, profileName, expected }) => {
    expect(resolveRequiredProfile(config, profileName)).toMatchObject(expected);
  });

  it.each([
    ["https://user:pass@remote-browser.example.com:443/json/version?token=abc#frag", 443],
    ["wss://remote-browser.example.com:443/json/version?token=abc", 443],
    ["http://[::1]:80/json/version?token=abc", 80],
  ] as const)("preserves explicit default port and URL details: %s", (cdpUrl, cdpPort) => {
    expect(
      resolveRequiredProfile(
        withProfile("openclaw", { cdpPort: 18800, cdpUrl, driver: "openclaw" }),
        "openclaw",
      ),
    ).toMatchObject({ cdpPort, cdpUrl });
  });

  it("userinfo colons without a URL port defer to cdpPort", () => {
    const config = withProfile("openclaw", {
      cdpPort: 18800,
      cdpUrl: "http://user:pass@127.0.0.1/json/version",
      driver: "openclaw",
    });
    expect(resolveRequiredProfile(config, "openclaw")).toMatchObject({
      cdpPort: 18800,
      cdpUrl: "http://user:pass@127.0.0.1:18800/json/version",
    });
  });

  it("rejects openclaw profiles without cdpPort or cdpUrl", () => {
    const resolved = resolveBrowserConfig(withProfile("bad", { driver: "openclaw" }));
    expect(() => resolveProfile(resolved, "bad")).toThrow("must define cdpPort or cdpUrl");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ cdpUrl: "ftp://127.0.0.1:18791" })).toThrow(
      "must be http(s) or ws(s)",
    );
  });

  it.each<[BrowserConfig | undefined, string[]]>([
    [undefined, []],
    [{ extraArgs: ["--flag", "", "  ", "--other"] }, ["--flag", "--other"]],
    [
      { extraArgs: ["--flag", 42, null, undefined, true, "--other"] as unknown as string[] },
      ["--flag", "--other"],
    ],
    [{ extraArgs: "not-an-array" as unknown as string[] }, []],
  ])("normalizes extraArgs in %j", (config, expected) => {
    expect(resolveBrowserConfig(config).extraArgs).toStrictEqual(expected);
  });

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
      name: "defaults browser SSRF policy to strict mode when unset",
      config: {},
      expected: {},
    },
    {
      name: "supports explicit strict mode by disabling private network access",
      config: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
      expected: { dangerouslyAllowPrivateNetwork: false },
    },
    {
      name: "keeps allowlist-only browser SSRF policy strict by default",
      config: {
        ssrfPolicy: { allowedHostnames: ["example.com", "*.example.com"] },
      } as unknown as BrowserConfig,
      expected: { allowedHostnames: ["example.com", "*.example.com"] },
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
      name: "resolves existing-session profiles without cdpPort or cdpUrl",
      config: {
        profiles: { "chrome-live": { driver: "existing-session", attachOnly: true } },
      },
      profileName: "chrome-live",
      exact: true,
      expected: {
        name: "chrome-live",
        engine: "chromium",
        driver: "existing-session",
        attachOnly: true,
        cdpPort: 0,
        cdpUrl: "",
        cdpHost: "",
        cdpIsLoopback: true,
        color: "#FF4500",
        executablePath: undefined,
        headless: false,
        headlessSource: "default",
        mcpArgs: undefined,
        mcpCommand: undefined,
        userDataDir: undefined,
      },
    },
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
      name: "applies top-level cdpUrl to an existing-session default profile",
      config: { defaultProfile: "user", cdpUrl: "http://127.0.0.1:9222/" },
      profileName: "user",
      expectedDefaultProfile: "user",
      expected: {
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
      },
    },
    {
      name: "keeps explicit existing-session profile cdpUrl over the top-level cdpUrl",
      config: withProfile(
        "chrome-live",
        {
          driver: "existing-session",
          attachOnly: true,
          cdpUrl: "http://127.0.0.1:9333",
          color: "#00AA00",
        },
        { defaultProfile: "chrome-live", cdpUrl: "http://127.0.0.1:9222" },
      ),
      profileName: "chrome-live",
      expected: { driver: "existing-session", cdpUrl: "http://127.0.0.1:9333" },
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

  it("sets usesChromeMcp only for existing-session profiles", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-live": { driver: "existing-session", attachOnly: true, color: "#00AA00" },
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const existingSession = resolveProfile(resolved, "chrome-live")!;
    expect(getBrowserProfileCapabilities(existingSession).usesChromeMcp).toBe(true);

    const managed = resolveProfile(resolved, "openclaw")!;
    expect(getBrowserProfileCapabilities(managed).usesChromeMcp).toBe(false);

    const work = resolveProfile(resolved, "work")!;
    expect(getBrowserProfileCapabilities(work).usesChromeMcp).toBe(false);
  });

  it("resolves a configured custom default profile", () => {
    const resolved = resolveBrowserConfig({
      defaultProfile: "custom",
      profiles: {
        custom: { cdpPort: 19999 },
      },
    });

    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(resolved.defaultProfile).toBe("custom");
    expect(profile?.name).toBe("custom");
    expect(profile?.cdpPort).toBe(19999);
  });
});
