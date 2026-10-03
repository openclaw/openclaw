import { describe, expect, it, vi } from "vitest";
import { noteChromeMcpBrowserReadiness } from "./doctor-browser.js";

type BrowserConfig = NonNullable<Parameters<typeof noteChromeMcpBrowserReadiness>[0]["browser"]>;
type DoctorDeps = NonNullable<Parameters<typeof noteChromeMcpBrowserReadiness>[1]>;
const managedHost = {
  platform: "linux",
  env: { DISPLAY: ":99" },
  getUid: () => 1000,
  resolveManagedExecutable: () => ({ kind: "chrome", path: "/usr/bin/google-chrome" }),
} satisfies DoctorDeps;

async function diagnose(browser: BrowserConfig, deps: DoctorDeps = {}) {
  const noteFn = vi.fn();
  await noteChromeMcpBrowserReadiness(
    { browser: { extensionRelay: { allowLegacyAuth: false }, ...browser } },
    { ...managedHost, ...deps, noteFn },
  );
  const notes = noteFn.mock.calls.map(([message]) => String(message));
  return { noteFn, text: notes.join("\n") };
}

describe("browser doctor readiness", () => {
  it("warns while legacy Browser Relay Authentication remains enabled", async () => {
    const { noteFn } = await diagnose({
      extensionRelay: { allowLegacyAuth: true },
      profiles: { openclaw: { cdpPort: 18800 } },
    });
    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("browser.extensionRelay.allowLegacyAuth=true"),
      "Browser relay authentication",
    );
  });

  it("warns when Chrome MCP is configured but Chrome is missing", async () => {
    const { text } = await diagnose(
      { defaultProfile: "user" },
      { platform: "darwin", resolveChromeExecutable: () => null },
    );
    expect(text).toContain("Google Chrome was not found");
    expect(text).toContain("brave://inspect/#remote-debugging");
    expect(text).toContain("System browser profile cookie import is enabled");
    expect(text).toContain("System browser profile discovery skipped");
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
      const { noteFn, text } = await diagnose(
        { profiles: { chromeLive: { driver: "existing-session", color: "#00AA00" } } },
        {
          platform,
          resolveChromeExecutable: () => ({ path: "/chrome" }),
          readVersion: () => `Google Chrome ${version}`,
        },
      );
      expect(noteFn).toHaveBeenCalledTimes(1);
      expect(text).toContain(expected);
      if (version.startsWith("143")) {
        expect(text).toContain("Chrome 144+");
      }
    },
  );

  it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
    const { noteFn, text } = await diagnose(
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
    expect(noteFn).toHaveBeenCalled();
    expect(text).toContain("explicit Chromium user data directory");
    expect(text).toContain("brave://inspect/#remote-debugging");
  });
});
