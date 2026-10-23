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

it("warns when Chrome MCP is configured but Chrome is missing", async () => {
  const { text } = await diagnose({ defaultProfile: "user" }, { platform: "darwin" });
  expect(text).toContain("Google Chrome was not found");
  expect(text).toContain("brave://inspect/#remote-debugging");
  expect(text).not.toContain("System browser profile cookie import");
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
  const accesses: string[] = [];
  const denyProfileRead = (target: unknown) => {
    const filename = path.basename(String(target));
    if (["Local State", "Preferences", "Secure Preferences", "Cookies"].includes(filename)) {
      accesses.push(String(target));
      throw Object.assign(new Error("synthetic browser profile access denied"), { code: "EACCES" });
    }
  };
  const readSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    denyProfileRead(args[0]);
    return readSync(...args);
  });
  const read = fsp.readFile;
  vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
    denyProfileRead(args[0]);
    return await read(...args);
  });
  const roots = new Set(install.chromeProductRoots(value.deps).map((root) => root.userDataDir));
  const rootReads = [vi.spyOn(fsp, "lstat"), vi.spyOn(fsp, "readdir")];
  Object.entries(value.deps.env).forEach(([key, entry]) => vi.stubEnv(key, entry));
  vi.stubEnv("OPENCLAW_STATE_DIR", value.stateDir);
  const configHome = path.join(value.homeDir, ".config");
  ["CHROME_CONFIG_HOME", "XDG_CONFIG_HOME"].forEach((key) => vi.stubEnv(key, configHome));
  const rootAccesses = () =>
    rootReads
      .flatMap((spy) => spy.mock.calls.map(([target]) => String(target)))
      .filter((target) => roots.has(target));
  return { ...value, accesses: () => [...accesses, ...rootAccesses()] };
}

it.each([
  ["darwin", false],
  ["darwin", true],
  ["linux", true],
  ["win32", true],
] as const)("does not inspect profiles on %s (installed copy: %s)", async (platform, installed) => {
  const value = await protectedProfiles(platform, installed);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  for (const allowSystemProfileImport of [false, undefined, true]) {
    const findings = await collectBrowserReadinessFindings({
      browser: { allowSystemProfileImport, extensionRelay: { allowLegacyAuth: false } },
    });
    expect(value.accesses()).toEqual([]);
    const notes = findings.map((finding) => `${finding.message}\n${finding.fixHint}`).join("\n");
    expect(notes).not.toContain("cookie databases found:");
    expect(notes).not.toContain("System browser profile cookie import");
    if (installed) {
      expect(findings).toContainEqual(
        expect.objectContaining({ category: "recommended", severity: "info" }),
      );
      expect(notes).toContain("native bootstrap was not inspected");
      expect(notes).toContain("openclaw browser extension status --json");
      expect(notes).not.toContain("not fully registered");
    }
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
