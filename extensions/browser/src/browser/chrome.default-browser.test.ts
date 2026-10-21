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
import path from "node:path";
import { fileURLToPath } from "node:url";
const actualFs = (await vi.importActual<{ default: typeof fs }>("node:fs")).default;
const { resolveBrowserExecutableForPlatform, resolveGoogleChromeExecutableForPlatform } =
  await import("./chrome.executables.js");

describe("browser default executable detection", () => {
  const launchServicesPlist = "com.apple.launchservices.secure.plist";
  const chromeExecutablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const config = {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0];
  const operaInstall = "C:\\Users\\test\\AppData\\Local\\Programs\\Opera";
  const operaLauncher = `${operaInstall}\\launcher.exe`;

  function expectBrowser(platform: NodeJS.Platform, kind: string, executable: string) {
    expect(resolveBrowserExecutableForPlatform(config, platform)).toEqual({
      kind,
      path: executable,
    });
  }

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
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      [launchServicesPlist, chromeExecutablePath].some((name) => String(p).includes(name)),
    );
  }

  function mockExisting(...paths: string[]): void {
    vi.mocked(fs.existsSync).mockImplementation((p) => paths.includes(String(p)));
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
    mockExisting(firstCandidate, executableCandidate);
    mockExecutableAccessDeniedFor(firstCandidate);

    expectBrowser("linux", "chrome", executableCandidate);
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

    expectBrowser("linux", "chromium", executableCandidate);
  });

  const cacheEnvNames = {
    direct: "PLAYWRIGHT_BROWSERS_PATH",
    npm: "npm_config_playwright_browsers_path",
    package: "npm_package_config_playwright_browsers_path",
    cwd: "INIT_CWD",
    npmCwd: "npm_config_init_cwd",
    packageCwd: "npm_package_config_init_cwd",
    xdg: "XDG_CACHE_HOME",
  };
  type CacheEnv = Record<string, string>;
  it.each<[string, string, CacheEnv, ("arm64" | "x64")?]>([
    ["XDG ARM64", "/tmp/xdg-cache/ms-playwright", { xdg: "/tmp/xdg-cache" }, "arm64"],
    ["empty XDG", "/Users/test/.cache/ms-playwright", { xdg: "" }],
    ["relative install root", "/tmp/install/browsers", { direct: "browsers", cwd: "/tmp/install" }],
    ["relative working directory", "/tmp/runtime/browsers", { direct: "browsers" }],
    ["npm cache", "/tmp/npm-cache", { npm: "/tmp/npm-cache" }],
    ["package cache", "/tmp/package-cache", { package: "/tmp/package-cache" }],
    [
      "direct cache precedence",
      "/tmp/direct-cache",
      { direct: "/tmp/direct-cache", npm: "/tmp/ignored" },
    ],
    ["npm cache precedence", "/tmp/npm-cache", { npm: "/tmp/npm-cache", package: "/tmp/ignored" }],
    ["empty direct cache", "/Users/test/.cache/ms-playwright", { direct: "", npm: "/tmp/ignored" }],
    [
      "npm install root",
      "/tmp/npm-install/browsers",
      { direct: "browsers", npmCwd: "/tmp/npm-install" },
    ],
    [
      "package install root",
      "/tmp/package-install/browsers",
      { direct: "browsers", packageCwd: "/tmp/package-install" },
    ],
    [
      "empty direct install root",
      "/tmp/runtime/browsers",
      { direct: "browsers", cwd: "", npmCwd: "/tmp/ignored" },
    ],
    [
      "relative XDG install root",
      "/tmp/install/cache/ms-playwright",
      { xdg: "cache", cwd: "/tmp/install" },
    ],
    ["cache path spaces", "/tmp/install/ browsers ", { direct: " browsers ", cwd: "/tmp/install" }],
    [
      "hermetic install",
      path.join(
        path.dirname(fileURLToPath(import.meta.resolve("playwright-core/package.json"))),
        ".local-browsers",
      ),
      { direct: "0" },
    ],
  ])(
    "discovers Playwright Chromium in the %s cache layout",
    (_name, browserCache, environment, arch = "x64") => {
      for (const [name, variable] of Object.entries(cacheEnvNames)) {
        vi.stubEnv(variable, environment[name]);
      }
      vi.spyOn(process, "arch", "get").mockReturnValue(arch);
      vi.spyOn(process, "cwd").mockReturnValue("/tmp/runtime");
      const linuxDir = arch === "arm64" ? "chrome-linux-arm64" : "chrome-linux64";
      const executable = `${browserCache}/chromium-1243/${linuxDir}/chrome`;
      vi.mocked(fs.readdirSync).mockImplementation((candidate) => {
        return (String(candidate) === browserCache ? ["chromium-1243"] : []) as never;
      });
      mockExisting(executable);

      expectBrowser("linux", "chromium", executable);
    },
  );

  it("preserves executable and cache precedence when ARM64 Chromium is installed", () => {
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
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
    expectBrowser("linux", "chrome", system);
    installed.delete(system);
    expectBrowser("linux", "chromium", configured);
    mockExecutableAccessDeniedFor(configured);
    expectBrowser("linux", "chromium", defaultExecutable);
  });

  it("classifies beta Linux Google Chrome builds as canary", () => {
    mockExisting("/usr/bin/google-chrome-beta");
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
    expectBrowser("darwin", "edge", edgeExecutablePath);
  });

  it("falls back to Chrome when Edge LaunchServices lookup has no app path", () => {
    mockMacDefaultBrowser("com.microsoft.edgemac");
    mockChromeExecutableExists();
    expectBrowser("darwin", "chrome", chromeExecutablePath);
  });

  it("finds a user-installed macOS browser after exhausting system candidates", () => {
    const expectedPath =
      "/Users/test/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
    mockExisting(expectedPath);
    expectBrowser("darwin", "canary", expectedPath);
  });

  it("resolves an Opera default-browser launcher to the directly owned binary on Windows", () => {
    const opera = `${operaInstall}\\100.0.4815.76\\opera.exe`;
    vi.mocked(execFileSync)
      .mockReturnValueOnce("ProgId    REG_SZ    OperaStable")
      .mockReturnValueOnce(`(Default)    REG_SZ    "${operaLauncher}" "%1"`);
    mockExisting(operaLauncher, opera);
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate).endsWith("installation_status.json")) {
        return JSON.stringify({ _subfolder: "100.0.4815.76" });
      }
      throw new Error(`unexpected file: ${String(candidate)}`);
    });

    expectBrowser("win32", "chromium", opera);
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
    mockExisting(expected);

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
    mockExisting(expected);

    expectBrowser("win32", "chrome", expected);
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(expected);
  });

  it("canonicalizes an explicitly configured Opera launcher", () => {
    const opera = `${operaInstall}\\101.0.4843.33\\opera.exe`;
    mockExisting(operaLauncher, opera);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ _subfolder: "101.0.4843.33" }));

    const exe = resolveBrowserExecutableForPlatform(
      { ...config, executablePath: operaLauncher },
      "win32",
    );

    expect(exe).toEqual({ kind: "custom", path: opera });
  });
});
