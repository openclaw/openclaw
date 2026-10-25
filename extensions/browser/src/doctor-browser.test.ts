import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { maybeRepairOwnedChromeExtensionNativeHosts } from "../browser-doctor.js";
import { readBrowserVersion } from "./browser/chrome.executable-probe.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser/chrome.executables.js";
import * as install from "./browser/extension-install-fixture.test-support.js";
import { useExtensionInstallFixture } from "./browser/extension-install.test-support.js";
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
const extensionFixture = useExtensionInstallFixture();
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
  const findings = await collectBrowserReadinessFindings({
    browser: { extensionRelay: { allowLegacyAuth: false }, ...browser },
  });
  return {
    findings,
    text: findings.map((finding) => `${finding.message}\n${finding.fixHint}`).join("\n"),
  };
}

it("warns while legacy Browser Relay Authentication remains enabled", async () => {
  const { findings } = await diagnose({ extensionRelay: { allowLegacyAuth: true } });
  expect(findings).toContainEqual(
    expect.objectContaining({
      category: "recommended",
      severity: "warning",
      message: expect.stringContaining("browser.extensionRelay.allowLegacyAuth=true"),
    }),
  );
});

it.each<[string, BrowserConfig, "managed" | "mcp" | false]>([
  ["custom default Chrome MCP", withProfile(mcpProfile, "work", { defaultProfile: "work" }), "mcp"],
  ["explicit Chrome MCP endpoint", withProfile(remoteMcp), false],
  ["MCP auto-connect override", withProfile({ ...remoteMcp, mcpArgs: ["--autoConnect"] }), "mcp"],
  [
    "managed user override",
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
  [
    "attach-only override",
    withProfile({ cdpPort: 18801, attachOnly: false }, "work", { attachOnly: true }),
    "managed",
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
  expect(text.includes("No Chromium-based browser executable was found")).toBe(managed);
  expect(text.includes("No DISPLAY or WAYLAND_DISPLAY is set")).toBe(managed);
  expect(text.includes("The Gateway is running as root")).toBe(managed);
  expect(text.includes("Google Chrome was not found")).toBe(chromeMcp);
  if (chromeMcp) {
    expect(text).toContain("brave://inspect/#remote-debugging");
  }
});

it.each([
  ["profile", {}, { headless: false }, "browser.profiles.work.headless=false"],
  [
    "environment",
    { OPENCLAW_BROWSER_HEADLESS: "0" },
    { headless: true },
    "OPENCLAW_BROWSER_HEADLESS=0",
  ],
] as const)("names the effective %s display requirement", async (_source, env, profile, hint) => {
  const { text } = await diagnose(
    withProfile({ cdpPort: 18801, ...profile }, "work", { headless: true }),
    { env },
  );
  expect(text.includes("DISPLAY") || text.includes("Linux display server")).toBe(true);
  expect(text).toContain(hint);
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
  expect(resolveManagedExecutable.mock.calls.map(([resolved]) => resolved.executablePath)).toEqual([
    "/custom/chrome",
    "/global/missing-chrome",
  ]);
  expect(text).toContain("A configured browser executable could not be used");
  expect(text).toContain("Correct browser.executablePath");
  expect(text).toContain("profile(s) are configured: fallback.");
  expect(text).not.toContain("custom");
  expect(text).not.toContain("shared");
});

it.each([
  ["143.0.7499.4", "linux", "too old"],
  ["144.0.7534.0", "win32", "Detected Chrome Google Chrome 144.0.7534.0"],
] as const)("reports Chrome MCP compatibility for %s", async (version, platform, expected) => {
  const { findings, text } = await diagnose(withProfile(mcpProfile), {
    platform,
    resolveChromeExecutable: () => ({ kind: "chrome", path: "/chrome" }),
    readVersion: () => `Google Chrome ${version}`,
  });
  expect(findings).toHaveLength(1);
  expect(findings[0]?.category).toBe(version.startsWith("143") ? "fix-now" : "recommended");
  expect(findings[0]?.severity).toBe(version.startsWith("143") ? "warning" : "info");
  expect(text).toContain(expected);
  if (version.startsWith("143")) {
    expect(text).toContain("Chrome 144+");
  }
});

it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
  const { findings, text } = await diagnose(
    withProfile({ ...mcpProfile, userDataDir: "/profiles/brave" }),
    {
      resolveChromeExecutable: () => {
        throw new Error("should not look up Chrome");
      },
    },
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ category: "recommended", severity: "info" });
  expect(text).toContain("explicit Chromium user data directory");
  expect(text).toContain("brave://inspect/#remote-debugging");
});

async function protectedProfiles(platform: NodeJS.Platform, installed: boolean) {
  const value = await extensionFixture(platform);
  if (installed) {
    await install.installStableChromeExtension(value.bundledDir, value.deps);
  }
  for (const root of install.chromeProductRoots(value.deps)) {
    const profileDir = path.join(root.userDataDir, "Default");
    await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
    for (const filename of ["Preferences", "Secure Preferences"]) {
      await fsp.writeFile(path.join(profileDir, filename), "{}", { mode: 0o600 });
    }
  }
  const roots = install.chromeProductRoots(value.deps).map((root) => root.userDataDir);
  const reads = [
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fsp, "readFile"),
    vi.spyOn(fsp, "lstat"),
    vi.spyOn(fsp, "readdir"),
  ];
  Object.entries(value.deps.env).forEach(([key, entry]) => vi.stubEnv(key, entry));
  vi.stubEnv("OPENCLAW_STATE_DIR", value.stateDir);
  const configHome = path.join(value.homeDir, ".config");
  ["CHROME_CONFIG_HOME", "XDG_CONFIG_HOME"].forEach((key) => vi.stubEnv(key, configHome));
  const accesses = () =>
    reads
      .flatMap((spy) => spy.mock.calls.map(([target]) => String(target)))
      .filter(
        (target) =>
          ["Local State", "Preferences", "Secure Preferences", "Cookies"].includes(
            path.basename(target),
          ) || roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)),
      );
  return { ...value, accesses };
}

it.each([
  ["darwin", false],
  ["darwin", true],
  ["linux", true],
  ["win32", true],
] as const)("does not inspect profiles on %s (installed copy: %s)", async (platform, installed) => {
  const value = await protectedProfiles(platform, installed);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  const findings = await collectBrowserReadinessFindings({
    browser: { allowSystemProfileImport: true, extensionRelay: { allowLegacyAuth: false } },
  });
  expect(value.accesses()).toEqual([]);
  if (installed) {
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "recommended", severity: "info" }),
    );
    const notes = findings.map((finding) => `${finding.message}\n${finding.fixHint}`).join("\n");
    expect(notes).toContain("native bootstrap was not inspected");
    expect(notes).toContain("openclaw browser extension status --json");
    expect(notes).not.toContain("not fully registered");
  }
  await install.discoverChromeExtensionIds({ approvedDirs: [], deps: value.deps });
  expect(value.accesses()).toContain(install.chromeProductRoots(value.deps)[0]!.userDataDir);
});

it("reports native-host repair as skipped without discovering profiles or claiming changes", async () => {
  const value = await protectedProfiles(process.platform, true);
  vi.spyOn(os, "homedir").mockReturnValue(value.homeDir);
  const result = await maybeRepairOwnedChromeExtensionNativeHosts();
  expect(value.accesses()).toEqual([]);
  expect(result).toMatchObject({ changes: [], status: "skipped" });
  expect(result.reason).toContain("Doctor does not inspect personal browser profiles");
  expect(result.warnings.join("\n")).toContain("native-host repair skipped");
  expect(result.warnings.join("\n")).toContain("openclaw browser extension install");
});
