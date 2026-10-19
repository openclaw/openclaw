import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { readBrowserVersion } from "./browser/chrome.executable-probe.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser/chrome.executables.js";
import { noteChromeMcpBrowserReadiness } from "./doctor-browser.js";

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

type BrowserConfig = NonNullable<Parameters<typeof noteChromeMcpBrowserReadiness>[0]["browser"]>;
function withProfile(
  profile: NonNullable<BrowserConfig["profiles"]>[string],
  name = "work",
  browser: BrowserConfig = {},
): BrowserConfig {
  return { ...browser, profiles: { [name]: profile } };
}
const mcpProfile = { driver: "existing-session" } as const;
const remoteMcp = { ...mcpProfile, cdpUrl: "https://browser.example" };
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
  resolveChromeExecutable: () => null,
  readVersion: () => null,
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
    .mockImplementation(host.resolveChromeExecutable);
  vi.mocked(readBrowserVersion).mockReset().mockImplementation(host.readVersion);
  const noteFn = vi.fn();
  await noteChromeMcpBrowserReadiness(
    { browser: { extensionRelay: { allowLegacyAuth: false }, ...browser } },
    { noteFn },
  );
  return { noteFn, text: noteFn.mock.calls.map(([message]) => String(message)).join("\n") };
}

it("warns while legacy Browser Relay Authentication remains enabled", async () => {
  const { noteFn } = await diagnose({ extensionRelay: { allowLegacyAuth: true } });
  expect(noteFn).toHaveBeenCalledWith(
    expect.stringContaining("browser.extensionRelay.allowLegacyAuth=true"),
    "Browser relay authentication",
  );
});

it("warns when Chrome MCP is configured but Chrome is missing", async () => {
  const { text } = await diagnose({ defaultProfile: "user" }, { platform: "darwin" });
  expect(text).toContain("Google Chrome was not found");
  expect(text).toContain("brave://inspect/#remote-debugging");
  expect(text).toContain("System browser profile cookie import is enabled");
  expect(text).toContain("System browser profile discovery skipped");
});

it.each<[string, BrowserConfig, "managed" | "mcp" | false]>([
  ["custom default Chrome MCP", withProfile(mcpProfile, "work", { defaultProfile: "work" }), "mcp"],
  ["explicit Chrome MCP endpoint", withProfile(remoteMcp), false],
  [
    "Chrome MCP endpoint arguments",
    withProfile({ ...mcpProfile, mcpArgs: ["--browserUrl", remoteMcp.cdpUrl] }),
    false,
  ],
  [
    "explicit Chrome MCP auto-connect override",
    withProfile({ ...remoteMcp, mcpArgs: ["--autoConnect"] }),
    "mcp",
  ],
  [
    "explicit managed override of user",
    withProfile({ driver: "openclaw", cdpPort: 18801 }, "user", { defaultProfile: "user" }),
    "managed",
  ],
  [
    "extension",
    withProfile({ driver: "extension" }, "chrome", { defaultProfile: "chrome" }),
    false,
  ],
  ["remote CDP", withProfile({ cdpUrl: "https://browser.example" }), false],
  ["profile attach-only", withProfile({ cdpPort: 18801, attachOnly: true }), false],
  ["inherited attach-only", withProfile({ cdpPort: 18801 }, "work", { attachOnly: true }), false],
  [
    "explicit managed override of inherited attach-only",
    withProfile({ cdpPort: 18801, attachOnly: false }, "work", { attachOnly: true }),
    "managed",
  ],
  [
    "Lightpanda",
    withProfile({ engine: "lightpanda", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true }),
    false,
  ],
  ["unconfigured built-ins", {}, false],
])("checks only launch prerequisites for %s", async (_name, browser, mode) => {
  const managed = mode === "managed";
  const chromeMcp = mode === "mcp";
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

it.each<[string, boolean | undefined, boolean | undefined, NodeJS.ProcessEnv, boolean]>([
  ["profile headless override", false, true, {}, false],
  ["profile headed override", true, false, {}, true],
  ["Linux headless default", undefined, undefined, {}, false],
  ["environment headless override", false, false, { OPENCLAW_BROWSER_HEADLESS: "1" }, false],
  ["environment headed override", true, true, { OPENCLAW_BROWSER_HEADLESS: "0" }, true],
])(
  "matches managed launch display requirements for %s",
  async (name, global, profile, env, warning) => {
    const { text } = await diagnose(
      withProfile({ cdpPort: 18801, headless: profile }, "work", { headless: global }),
      { env },
    );
    expect(text.includes("DISPLAY") || text.includes("Linux display server")).toBe(warning);
    if (warning) {
      expect(text).toContain(
        name === "profile headed override"
          ? "browser.profiles.work.headless=false"
          : "OPENCLAW_BROWSER_HEADLESS=0",
      );
    }
  },
);

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
  expect(resolveManagedExecutable.mock.calls.map(([resolved]) => resolved.executablePath)).toEqual([
    "/custom/chrome",
    "/global/missing-chrome",
  ]);
  expect(text).toContain("No Chromium-based browser executable");
  expect(text).toContain("profile(s) are configured: fallback.");
  expect(text).not.toMatch(/custom|shared/);
});

it.each([
  ["143.0.7499.4", "linux", "too old"],
  ["144.0.7534.0", "win32", "Detected Chrome Google Chrome 144.0.7534.0"],
] as const)("reports Chrome MCP compatibility for %s", async (version, platform, expected) => {
  const { noteFn, text } = await diagnose(withProfile(mcpProfile), {
    platform,
    resolveChromeExecutable: () => ({ kind: "chrome", path: "/chrome" }),
    readVersion: () => `Google Chrome ${version}`,
  });
  expect(noteFn).toHaveBeenCalledTimes(1);
  expect(text).toContain(expected);
  if (version.startsWith("143")) {
    expect(text).toContain("Chrome 144+");
  }
});

it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
  const { noteFn, text } = await diagnose(
    withProfile({ ...mcpProfile, userDataDir: "/profiles/brave" }),
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
