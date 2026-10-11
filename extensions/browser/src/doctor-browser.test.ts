import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrowserVersion } from "./browser/chrome.executable-probe.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser/chrome.executables.js";
import { collectBrowserReadinessFindings } from "./doctor-browser.js";

vi.mock("./browser/chrome.executables.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/chrome.executables.js")>()),
  resolveBrowserExecutableForPlatform: vi.fn(),
  resolveGoogleChromeExecutableForPlatform: vi.fn(),
}));
vi.mock("./browser/chrome.executable-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/chrome.executable-probe.js")>()),
  readBrowserVersion: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>();
  return {
    ...actual,
    get CONFIG_DIR() {
      return process.env.OPENCLAW_STATE_DIR ?? actual.CONFIG_DIR;
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  if (uidDescriptor) {
    Object.defineProperty(process, "getuid", uidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type BrowserConfig = NonNullable<Parameters<typeof collectBrowserReadinessFindings>[0]["browser"]>;
type DoctorHost = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  getUid?: () => number;
  resolveManagedExecutable?: typeof resolveBrowserExecutableForPlatform;
  resolveChromeExecutable?: typeof resolveGoogleChromeExecutableForPlatform;
  readVersion?: typeof readBrowserVersion;
};
const managedHost = {
  platform: "linux",
  env: { DISPLAY: ":99" },
  getUid: () => 1000,
  resolveManagedExecutable: () => ({ kind: "chrome", path: "/usr/bin/google-chrome" }),
} satisfies DoctorHost;

async function diagnose(browser: BrowserConfig, overrides: DoctorHost = {}) {
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("browser-doctor-"));
  const host = { ...managedHost, ...overrides };
  const env: NodeJS.ProcessEnv = host.env;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: host.platform });
  Object.defineProperty(process, "getuid", { configurable: true, value: host.getUid });
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "OPENCLAW_BROWSER_HEADLESS"]) {
    vi.stubEnv(key, env[key]);
  }
  vi.mocked(resolveBrowserExecutableForPlatform)
    .mockReset()
    .mockImplementation(host.resolveManagedExecutable);
  vi.mocked(resolveGoogleChromeExecutableForPlatform)
    .mockReset()
    .mockImplementation(host.resolveChromeExecutable ?? (() => null));
  vi.mocked(readBrowserVersion)
    .mockReset()
    .mockImplementation(host.readVersion ?? (() => null));
  const findings = await collectBrowserReadinessFindings({
    browser: { extensionRelay: { allowLegacyAuth: false }, ...browser },
  });
  return {
    findings,
    text: findings.map((finding) => `${finding.message}\n${finding.fixHint}`).join("\n"),
  };
}

describe("browser doctor readiness", () => {
  it("warns while legacy Browser Relay Authentication remains enabled", async () => {
    const { findings } = await diagnose({
      extensionRelay: { allowLegacyAuth: true },
      profiles: { openclaw: { cdpPort: 18800 } },
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "recommended",
          message: expect.stringContaining("browser.extensionRelay.allowLegacyAuth=true"),
        }),
      ]),
    );
  });

  it("warns when Chrome MCP is configured but Chrome is missing", async () => {
    const { text } = await diagnose(
      { defaultProfile: "user" },
      { platform: "darwin", resolveChromeExecutable: () => null },
    );
    expect(text).toContain("Google Chrome was not found");
    expect(text).toContain("brave://inspect/#remote-debugging");
    expect(text).not.toContain("System browser profile cookie import");
    expect(text).not.toContain("System browser profile discovery skipped");
  });

  it.each<[string, BrowserConfig, boolean, boolean]>([
    [
      "custom default Chrome MCP",
      { defaultProfile: "work", profiles: { work: { driver: "existing-session" } } },
      false,
      true,
    ],
    [
      "explicit Chrome MCP endpoint",
      { profiles: { endpoint: { driver: "existing-session", cdpUrl: "https://browser.example" } } },
      false,
      false,
    ],
    [
      "Chrome MCP endpoint arguments",
      {
        profiles: {
          endpoint: {
            driver: "existing-session",
            mcpArgs: ["--browserUrl", "https://browser.example"],
          },
        },
      },
      false,
      false,
    ],
    [
      "explicit Chrome MCP auto-connect override",
      {
        profiles: {
          local: {
            driver: "existing-session",
            cdpUrl: "https://browser.example",
            mcpArgs: ["--autoConnect"],
          },
        },
      },
      false,
      true,
    ],
    [
      "explicit managed override of user",
      { defaultProfile: "user", profiles: { user: { driver: "openclaw", cdpPort: 18801 } } },
      true,
      false,
    ],
    [
      "extension",
      { defaultProfile: "chrome", profiles: { chrome: { driver: "extension" } } },
      false,
      false,
    ],
    ["remote CDP", { profiles: { remote: { cdpUrl: "https://browser.example" } } }, false, false],
    [
      "profile attach-only",
      { profiles: { attached: { cdpPort: 18801, attachOnly: true } } },
      false,
      false,
    ],
    [
      "inherited attach-only",
      { attachOnly: true, profiles: { attached: { cdpPort: 18801 } } },
      false,
      false,
    ],
    [
      "explicit managed override of inherited attach-only",
      { attachOnly: true, profiles: { local: { cdpPort: 18801, attachOnly: false } } },
      true,
      false,
    ],
    [
      "Lightpanda",
      {
        profiles: {
          lightweight: { engine: "lightpanda", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
        },
      },
      false,
      false,
    ],
    ["unconfigured built-ins", {}, false, false],
  ])("checks only launch prerequisites for %s", async (_name, browser, managed, chromeMcp) => {
    const resolveManagedExecutable = vi.fn(() => null);
    const resolveChromeExecutable = vi.fn(() => null);
    const { text } = await diagnose(
      { headless: false, ...browser },
      { env: {}, getUid: () => 0, resolveManagedExecutable, resolveChromeExecutable },
    );
    expect(resolveManagedExecutable).toHaveBeenCalledTimes(managed ? 1 : 0);
    expect(resolveChromeExecutable).toHaveBeenCalledTimes(chromeMcp ? 1 : 0);
    expect(text.includes("No Chromium-based browser executable was found")).toBe(managed);
    expect(text.includes("No DISPLAY or WAYLAND_DISPLAY is set")).toBe(managed);
    expect(text.includes("The Gateway is running as root")).toBe(managed);
    expect(text.includes("Google Chrome was not found")).toBe(chromeMcp);
  });

  it.each([
    { name: "profile headless override", global: false, profile: true, env: {}, warning: false },
    { name: "profile headed override", global: true, profile: false, env: {}, warning: true },
    {
      name: "Linux headless default",
      global: undefined,
      profile: undefined,
      env: {},
      warning: false,
    },
    {
      name: "environment headless override",
      global: false,
      profile: false,
      env: { OPENCLAW_BROWSER_HEADLESS: "1" },
      warning: false,
    },
    {
      name: "environment headed override",
      global: true,
      profile: true,
      env: { OPENCLAW_BROWSER_HEADLESS: "0" },
      warning: true,
    },
  ])("matches managed launch display requirements for $name", async (testCase) => {
    const { text } = await diagnose(
      {
        headless: testCase.global,
        profiles: { work: { cdpPort: 18801, headless: testCase.profile } },
      },
      { env: testCase.env },
    );
    expect(text.includes("DISPLAY") || text.includes("Linux display server")).toBe(
      testCase.warning,
    );
    if (testCase.warning) {
      expect(text).toContain(
        testCase.name === "profile headed override"
          ? "browser.profiles.work.headless=false"
          : "OPENCLAW_BROWSER_HEADLESS=0",
      );
    }
  });

  it("checks effective executables once per path and names only profiles missing a browser", async () => {
    const resolveManagedExecutable = vi.fn((resolved: { executablePath?: string }) =>
      resolved.executablePath === "/custom/chrome"
        ? { kind: "chrome" as const, path: resolved.executablePath }
        : null,
    );
    const { text } = await diagnose(
      {
        executablePath: "/global/missing-chrome",
        profiles: {
          custom: { cdpPort: 18801, executablePath: "/custom/chrome" },
          fallback: { cdpPort: 18802 },
          shared: { cdpPort: 18803, executablePath: "/custom/chrome" },
        },
      },
      { resolveManagedExecutable },
    );
    expect(
      resolveManagedExecutable.mock.calls.map(([resolved]) => resolved.executablePath),
    ).toEqual(["/custom/chrome", "/global/missing-chrome"]);
    expect(text).toContain("No Chromium-based browser executable");
    expect(text).toContain("profile(s) are configured: fallback.");
    expect(text).not.toContain("custom");
    expect(text).not.toContain("shared");
  });

  it.each([
    { version: "143.0.7499.4", platform: "linux", expected: "too old" },
    {
      version: "144.0.7534.0",
      platform: "win32",
      expected: "Detected Chrome Google Chrome 144.0.7534.0",
    },
  ] as const)(
    "reports Chrome MCP compatibility for $version",
    async ({ version, platform, expected }) => {
      const { findings, text } = await diagnose(
        { profiles: { chromeLive: { driver: "existing-session", color: "#00AA00" } } },
        {
          platform,
          resolveChromeExecutable: () => ({ kind: "chrome", path: "/chrome" }),
          readVersion: () => `Google Chrome ${version}`,
        },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.category).toBe(version.startsWith("143") ? "fix-now" : "recommended");
      expect(text).toContain(expected);
      if (version.startsWith("143")) {
        expect(text).toContain("Chrome 144+");
      }
    },
  );

  it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
    const { findings, text } = await diagnose(
      {
        profiles: {
          braveLive: {
            driver: "existing-session",
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
            color: "#FB542B",
          },
        },
      },
      {
        resolveChromeExecutable: () => {
          throw new Error("should not look up Chrome");
        },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("recommended");
    expect(text).toContain("explicit Chromium user data directory");
    expect(text).toContain("brave://inspect/#remote-debugging");
  });
});
