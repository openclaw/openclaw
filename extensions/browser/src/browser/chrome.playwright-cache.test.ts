import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  ["linux", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"],
  [
    "darwin",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
  ],
  ["win32", "chrome-win64/chrome.exe", "chrome-headless-shell-win64/chrome-headless-shell.exe"],
] as const)("keeps full Chromium for dual-distribution %s caches", (platform, full, shell) => {
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
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  expect(
    resolveBrowserExecutableForPlatform(
      resolveBrowserConfig({
        executablePath: "/browsers/chrome-headless-shell",
        headless: false,
      }),
      "linux",
    ),
  ).toEqual({ kind: "custom", path: "/browsers/chrome-headless-shell" });
});
