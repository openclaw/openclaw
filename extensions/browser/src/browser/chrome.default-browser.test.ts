import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFileSync: vi.fn(),
    },
  );
});
vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const accessSync = vi.fn();
  const existsSync = vi.fn();
  const readdirSync = vi.fn();
  const readFileSync = vi.fn();
  const statSync = vi.fn();
  return mockNodeBuiltinModule(
    async () => actual,
    { accessSync, constants: actual.constants, existsSync, readdirSync, readFileSync, statSync },
    { mirrorToDefault: true },
  );
});
vi.mock("node:os", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const homedir = vi.fn();
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:os")>("node:os"),
    { homedir },
    { mirrorToDefault: true },
  );
});
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
const actualFs = (await vi.importActual<{ default: typeof fs }>("node:fs")).default;
const { resolveBrowserExecutableForPlatform, resolveGoogleChromeExecutableForPlatform } =
  await import("./chrome.executables.js");

describe("browser default executable detection", () => {
  const launchServicesPlist = "com.apple.launchservices.secure.plist";
  const chromeExecutablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const config = {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0];
  const operaInstall = "C:\\Users\\test\\AppData\\Local\\Programs\\Opera";
  const operaLauncher = `${operaInstall}\\launcher.exe`;

  function mockMacDefaultBrowser(bundleId: string, appPath = "", exeName = "Google Chrome"): void {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsStr = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "/usr/bin/plutil" && argsStr.includes("LSHandlers")) {
        return JSON.stringify([{ LSHandlerURLScheme: "http", LSHandlerRoleAll: bundleId }]);
      }
      if (cmd === "/usr/bin/osascript" && argsStr.includes("path to application id")) {
        return appPath;
      }
      if (cmd === "/usr/bin/defaults") {
        return exeName;
      }
      return "";
    });
  }

  function mockChromeExecutableExists(): void {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const value = String(p);
      if (value.includes(launchServicesPlist)) {
        return true;
      }
      return value.includes(chromeExecutablePath);
    });
  }

  function mockExecutableAccessDeniedFor(inaccessiblePath: string): void {
    vi.mocked(fs.accessSync).mockImplementation((candidate) => {
      if (String(candidate) === inaccessiblePath) {
        throw new Error("EACCES");
      }
    });
  }

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(fs.accessSync).mockReset();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockImplementation((candidate) => {
      if (!fs.existsSync(candidate)) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true } as fs.Stats;
    });
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(os.homedir).mockReset();
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
    vi.spyOn(actualFs, "statSync").mockImplementation(fs.statSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("skips non-executable Linux auto-discovery candidates", () => {
    const firstCandidate = "/usr/bin/google-chrome";
    const executableCandidate = "/usr/bin/google-chrome-stable";
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      return [firstCandidate, executableCandidate].includes(String(candidate));
    });
    mockExecutableAccessDeniedFor(firstCandidate);

    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chrome",
      path: executableCandidate,
    });
    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "chrome",
      path: executableCandidate,
    });
  });

  it("skips directories in the Playwright browser cache", () => {
    const browserCache = "/tmp/browsers";
    const directoryCandidate = `${browserCache}/chromium-100/chrome-linux64/chrome`;
    const executableCandidate = `${browserCache}/chromium-100/chrome-linux/chrome`;
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browserCache);
    vi.mocked(fs.readdirSync).mockReturnValue(["chromium-100"] as never);
    vi.mocked(fs.statSync).mockImplementation((candidate) => {
      const value = String(candidate);
      if (value !== directoryCandidate && value !== executableCandidate) {
        throw new Error("ENOENT");
      }
      return { isFile: () => value === executableCandidate } as fs.Stats;
    });

    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chromium",
      path: executableCandidate,
    });
  });

  it.each([
    ["XDG ARM64", "chrome-linux-arm64", "/tmp/xdg-cache"],
    ["empty XDG", "chrome-linux64", ""],
  ])("discovers Playwright Chromium in the %s cache layout", (_name, linuxDir, xdgCacheHome) => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", undefined);
    vi.stubEnv("XDG_CACHE_HOME", xdgCacheHome);
    const browserCache = `${xdgCacheHome || "/Users/test/.cache"}/ms-playwright`;
    const executable = `${browserCache}/chromium-1243/${linuxDir}/chrome`;
    vi.mocked(fs.readdirSync).mockImplementation((candidate) => {
      return (String(candidate) === browserCache ? ["chromium-1243"] : []) as never;
    });
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === executable);

    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chromium",
      path: executable,
    });
  });

  it("preserves executable and cache precedence when ARM64 Chromium is installed", () => {
    const browserCache = "/tmp/browsers";
    const configured = `${browserCache}/chromium-1243/chrome-linux-arm64/chrome`;
    const defaultCache = "/tmp/xdg-cache/ms-playwright";
    const defaultExecutable = `${defaultCache}/chromium-1243/chrome-linux-arm64/chrome`;
    const system = "/usr/bin/google-chrome";
    const custom = "/opt/custom/chrome";
    const installed = new Set([configured, defaultExecutable, system, custom]);
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browserCache);
    vi.stubEnv("XDG_CACHE_HOME", "/tmp/xdg-cache");
    vi.mocked(fs.readdirSync).mockReturnValue(["chromium-1243"] as never);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => installed.has(String(candidate)));

    expect(
      resolveBrowserExecutableForPlatform({ ...config, executablePath: custom }, "linux"),
    ).toEqual({ kind: "custom", path: custom });
    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chrome",
      path: system,
    });
    installed.delete(system);
    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chromium",
      path: configured,
    });
    mockExecutableAccessDeniedFor(configured);
    expect(resolveBrowserExecutableForPlatform(config, "linux")).toEqual({
      kind: "chromium",
      path: defaultExecutable,
    });
  });

  it("classifies beta Linux Google Chrome builds as canary", () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => String(candidate) === "/usr/bin/google-chrome-beta",
    );
    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
  });

  it("detects Edge via LaunchServices bundle ID (com.microsoft.edgemac)", () => {
    const edgeExecutablePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    mockMacDefaultBrowser(
      "com.microsoft.edgemac",
      "/Applications/Microsoft Edge.app/",
      "Microsoft Edge",
    );
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const value = String(p);
      // A failed default-browser lookup would choose Chrome, not Edge.
      return (
        value.includes(launchServicesPlist) ||
        value === edgeExecutablePath ||
        value.includes(chromeExecutablePath)
      );
    });
    expect(resolveBrowserExecutableForPlatform(config, "darwin")).toEqual({
      kind: "edge",
      path: edgeExecutablePath,
    });
  });

  it("falls back to Chrome when Edge LaunchServices lookup has no app path", () => {
    mockMacDefaultBrowser("com.microsoft.edgemac");
    mockChromeExecutableExists();
    expect(resolveBrowserExecutableForPlatform(config, "darwin")).toEqual({
      kind: "chrome",
      path: chromeExecutablePath,
    });
  });

  it("finds a user-installed macOS browser after exhausting system candidates", () => {
    const expectedPath =
      "/Users/test/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expectedPath);
    expect(resolveBrowserExecutableForPlatform(config, "darwin")).toEqual({
      kind: "canary",
      path: expectedPath,
    });
  });

  it("resolves an Opera default-browser launcher to the directly owned binary on Windows", () => {
    const opera = `${operaInstall}\\100.0.4815.76\\opera.exe`;
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    OperaStable")
      .mockReturnValueOnce(`(Default)    REG_SZ    "${operaLauncher}" "%1"`);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate);
      return value === operaLauncher || value === opera;
    });
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate).endsWith("installation_status.json")) {
        return JSON.stringify({ _subfolder: "100.0.4815.76" });
      }
      throw new Error(`unexpected file: ${String(candidate)}`);
    });

    expect(resolveBrowserExecutableForPlatform(config, "win32")).toEqual({
      kind: "chromium",
      path: opera,
    });
  });

  it("rejects an unsafe Opera launcher target and falls back to a direct browser", () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    OperaStable")
      .mockReturnValueOnce(`(Default)    REG_SZ    "${operaLauncher}" "%1"`);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: "..\\escape" }));
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate).toLowerCase();
      return (
        value === operaLauncher.toLowerCase() ||
        value.endsWith("\\google\\chrome\\application\\chrome.exe")
      );
    });

    const exe = resolveBrowserExecutableForPlatform(config, "win32");

    expect(exe?.path.toLowerCase()).toMatch(/\\google\\chrome\\application\\chrome\.exe$/);
  });

  it("treats blank Windows install roots as absent and preserves default path order", () => {
    vi.stubEnv("LOCALAPPDATA", " \t ");
    vi.stubEnv("ProgramFiles", "");
    vi.stubEnv("ProgramFiles(x86)", "   ");
    vi.mocked(os.homedir).mockReturnValue("C:\\Users\\test");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(resolveBrowserExecutableForPlatform(config, "win32")).toBeNull();
    expect(vi.mocked(fs.existsSync).mock.calls.map(([candidate]) => String(candidate))).toEqual([
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\test\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\test\\AppData\\Local\\Chromium\\Application\\chrome.exe",
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });

  it("keeps custom-root precedence for Google Chrome-only discovery", () => {
    vi.stubEnv("LOCALAPPDATA", "D:\\User Apps");
    vi.stubEnv("ProgramFiles", "D:\\System Apps");
    vi.stubEnv("ProgramFiles(x86)", "D:\\System Apps x86");
    const expected = "D:\\System Apps x86\\Google\\Chrome\\Application\\chrome.exe";
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveGoogleChromeExecutableForPlatform("win32")).toEqual({
      kind: "chrome",
      path: expected,
    });
    expect(vi.mocked(fs.existsSync).mock.calls.map(([candidate]) => String(candidate))).toEqual([
      "D:\\User Apps\\Google\\Chrome\\Application\\chrome.exe",
      "D:\\User Apps\\Google\\Chrome SxS\\Application\\chrome.exe",
      "D:\\System Apps\\Google\\Chrome\\Application\\chrome.exe",
      expected,
    ]);
  });

  it("expands blank Windows registry roots with platform defaults before fallback scanning", () => {
    vi.stubEnv("ProgramFiles", "   ");
    const expected = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    ChromeHTML")
      .mockReturnValueOnce(
        `(Default)    REG_SZ    "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" "%1"`,
      );
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveBrowserExecutableForPlatform(config, "win32")).toEqual({
      kind: "chrome",
      path: expected,
    });
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(expected);
  });

  it("canonicalizes an explicitly configured Opera launcher", () => {
    const opera = `${operaInstall}\\101.0.4843.33\\opera.exe`;
    vi.mocked(fs.existsSync).mockImplementation((candidate) => {
      const value = String(candidate);
      return value === operaLauncher || value === opera;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: "101.0.4843.33" }));

    const exe = resolveBrowserExecutableForPlatform(
      { ...config, executablePath: operaLauncher },
      "win32",
    );

    expect(exe).toEqual({ kind: "custom", path: opera });
  });
});
