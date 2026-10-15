import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./chrome.executables.js";
import { findPlaywrightChromiumExecutable } from "./chrome.playwright-cache.js";
import { resolveBrowserConfig } from "./config.js";

vi.mock("./chrome.executable-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.executable-probe.js")>()),
  execBrowserProbe: () => null,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cpu = {
  model: "Intel",
  speed: 0,
  times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
};
beforeEach(() => {
  vi.spyOn(os, "cpus").mockReturnValue([cpu]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function installFullChromium(cache: string): string {
  const directory = path.join(
    cache,
    "chromium-100",
    `chrome-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "chrome");
  fs.writeFileSync(executable, "", { mode: 0o755 });
  return executable;
}

it.each(["npm_config_playwright_browsers_path", "npm_package_config_playwright_browsers_path"])(
  "discovers full Chromium installed through %s",
  (variable) => {
    const cache = tempDirs.make("openclaw-browser-cache-alias-");
    const executable = installFullChromium(cache);
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", undefined);
    vi.stubEnv("npm_config_playwright_browsers_path", undefined);
    vi.stubEnv("npm_package_config_playwright_browsers_path", undefined);
    vi.stubEnv(variable, cache);
    expect(findPlaywrightChromiumExecutable("linux")).toEqual({
      kind: "chromium",
      path: executable,
    });
  },
);

it.each(["INIT_CWD", "npm_config_init_cwd", "npm_package_config_init_cwd"])(
  "resolves relative installation paths against %s",
  (variable) => {
    const installRoot = tempDirs.make("openclaw-browser-cache-relative-");
    const executable = installFullChromium(path.join(installRoot, "browsers"));
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "browsers");
    vi.stubEnv("INIT_CWD", undefined);
    vi.stubEnv("npm_config_init_cwd", undefined);
    vi.stubEnv("npm_package_config_init_cwd", undefined);
    vi.stubEnv(variable, installRoot);
    expect(findPlaywrightChromiumExecutable("linux")).toEqual({
      kind: "chromium",
      path: executable,
    });
  },
);

it("discovers full Chromium from the hermetic Playwright cache", () => {
  const packageRoot = path.dirname(
    fileURLToPath(import.meta.resolve("playwright-core/package.json")),
  );
  const cache = path.join(packageRoot, ".local-browsers");
  const executable = path.join(cache, "chromium-100", "chrome-linux64", "chrome");
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "0");
  vi.spyOn(fs, "readdirSync").mockImplementation((directory) => {
    return (String(directory) === cache ? ["chromium-100"] : []) as never;
  });
  vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
    if (String(candidate) !== executable) {
      throw new Error("ENOENT");
    }
    return { isFile: () => true } as fs.Stats;
  });
  vi.spyOn(fs, "accessSync").mockImplementation(() => {});
  expect(findPlaywrightChromiumExecutable("linux")).toEqual({ kind: "chromium", path: executable });
});

it.each([
  {
    platform: "linux",
    arch: "x64",
    suffix: ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  },
  {
    platform: "linux",
    arch: "arm64",
    suffix: ["chrome-headless-shell-linux-arm64", "chrome-headless-shell"],
  },
  {
    platform: "darwin",
    arch: "x64",
    suffix: ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  },
  {
    platform: "darwin",
    arch: "arm64",
    suffix: ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  },
  {
    platform: "win32",
    arch: "x64",
    suffix: ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  },
] as const)(
  "does not automatically select a shell-only $platform/$arch installation",
  ({ platform, arch, suffix }) => {
    const cache = platform === "win32" ? "C:\\browsers" : "/browsers";
    const join = platform === "win32" ? path.win32.join : path.join;
    const executablePath = join(cache, "chromium_headless_shell-100", ...suffix);
    const installedExecutable = executablePath;
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "chromium_headless_shell-100",
      "chromium-100",
    ] as never);
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (String(candidate) !== installedExecutable) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true } as fs.Stats;
    });
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    for (const headless of [false, true]) {
      expect(
        resolveBrowserExecutableForPlatform(resolveBrowserConfig({ headless }), platform),
      ).toBeNull();
    }
    expect(resolveGoogleChromeExecutableForPlatform(platform)).toBeNull();
  },
);

it.each([
  [
    "linux",
    "Intel",
    "chrome-linux64/chrome",
    "chrome-headless-shell-linux64/chrome-headless-shell",
  ],
  [
    "darwin",
    "Intel",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
  ],
  [
    "darwin",
    "Apple M1",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  ],
  [
    "win32",
    "Intel",
    "chrome-win64/chrome.exe",
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
  ],
] as const)("keeps full Chromium in %s caches on %s CPUs", (platform, cpuModel, full, shell) => {
  const cache = platform === "win32" ? "C:\\browsers" : "/browsers";
  const join = platform === "win32" ? path.win32.join : path.join;
  const fullPath = join(cache, "chromium-100", ...full.split("/"));
  const shellPath = join(cache, "chromium_headless_shell-100", ...shell.split("/"));
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
  vi.spyOn(fs, "readdirSync").mockReturnValue([
    "chromium_headless_shell-100",
    "chromium-100",
  ] as never);
  const installed = new Set([fullPath, shellPath]);
  vi.mocked(os.cpus).mockReturnValue([{ ...cpu, model: cpuModel }]);
  vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
    if (!installed.has(String(candidate))) {
      throw new Error("ENOENT");
    }
    return { isFile: () => true } as fs.Stats;
  });
  vi.spyOn(fs, "accessSync").mockImplementation(() => {});
  for (const headless of [false, true]) {
    expect(
      resolveBrowserExecutableForPlatform(resolveBrowserConfig({ headless }), platform),
    ).toEqual({
      kind: "chromium",
      path: fullPath,
    });
  }
  installed.delete(fullPath);
  for (const headless of [false, true]) {
    expect(
      resolveBrowserExecutableForPlatform(resolveBrowserConfig({ headless }), platform),
    ).toBeNull();
  }
});

it.each([
  ["linux", false],
  ["linux", true],
  ["darwin", false],
  ["darwin", true],
] as const)(
  "prefers full Chromium across %s cache roots (configured full: %s)",
  (platform, configuredFull) => {
    const configured = "/configured-browsers";
    const fallback =
      platform === "darwin"
        ? "/home/test/Library/Caches/ms-playwright"
        : "/fallback-cache/ms-playwright";
    const fullSuffix =
      platform === "darwin"
        ? "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        : "chrome-linux64/chrome";
    const fullPath = (cache: string) => path.join(cache, "chromium-100", fullSuffix);
    const shellPath = path.join(
      configured,
      "chromium_headless_shell-100",
      `chrome-headless-shell-${platform === "darwin" ? "mac-x64" : "linux64"}`,
      "chrome-headless-shell",
    );
    const installed = new Set([
      shellPath,
      fullPath(fallback),
      ...(configuredFull ? [fullPath(configured)] : []),
    ]);
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", configured);
    vi.stubEnv("XDG_CACHE_HOME", "/fallback-cache");
    vi.spyOn(fs, "readdirSync").mockImplementation((cache) => {
      if (![configured, fallback].includes(String(cache))) {
        throw new Error("ENOENT");
      }
      return ["chromium_headless_shell-100", "chromium-100"] as never;
    });
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (!installed.has(String(candidate))) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true } as fs.Stats;
    });
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    expect(findPlaywrightChromiumExecutable(platform)).toEqual({
      kind: "chromium",
      path: fullPath(configuredFull ? configured : fallback),
    });
  },
);

it("skips incomplete cache entries and chooses the newest executable revision", () => {
  const cache = tempDirs.make("openclaw-browser-cache-");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
  for (const revision of ["99", "100", "101"]) {
    const directory = path.join(
      cache,
      `chromium-${revision}`,
      `chrome-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    if (revision !== "101") {
      fs.writeFileSync(path.join(directory, "chrome"), "", { mode: 0o755 });
    }
  }
  expect(findPlaywrightChromiumExecutable("linux")?.path).toContain("chromium-100");
  const installed = path.join(cache, "explicit-chrome");
  fs.writeFileSync(installed, "");
  expect(
    resolveBrowserExecutableForPlatform(
      resolveBrowserConfig({ executablePath: installed }),
      "linux",
    ),
  ).toEqual({ kind: "custom", path: installed });
});

it("finds the macOS default cache without a configured browser path", () => {
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "");
  vi.spyOn(os, "homedir").mockReturnValue("/Users/test");
  const read = vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);
  expect(findPlaywrightChromiumExecutable("darwin")).toBeNull();
  expect(read).toHaveBeenCalledWith("/Users/test/Library/Caches/ms-playwright");
});

it("keeps explicit shell identity discoverable independently of configured launch mode", () => {
  const executable = path.join(tempDirs.make("openclaw-explicit-shell-"), "chrome-headless-shell");
  fs.writeFileSync(executable, "", { mode: 0o755 });
  expect(
    resolveBrowserExecutableForPlatform(
      resolveBrowserConfig({
        executablePath: executable,
        headless: false,
      }),
      "linux",
    ),
  ).toEqual({ kind: "custom", path: executable });
});
