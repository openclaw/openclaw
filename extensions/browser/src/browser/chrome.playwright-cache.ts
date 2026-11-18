/** Discover installed Playwright browsers without loading its runtime or downloading anything. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executableFileExistsSync } from "openclaw/plugin-sdk/path-existence-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserExecutable } from "./chrome.executable-types.js";

function getPlaywrightEnv(name: string): string | undefined {
  const suffix = name.toLowerCase();
  return (
    process.env[name] ??
    process.env[`npm_config_${suffix}`] ??
    process.env[`npm_package_config_${suffix}`]
  );
}

function cachePaths(platform: NodeJS.Platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  const join = pathApi.join;
  const configured = getPlaywrightEnv("PLAYWRIGHT_BROWSERS_PATH");
  const defaultCache =
    platform === "darwin"
      ? join(os.homedir(), "Library", "Caches")
      : platform === "win32"
        ? (normalizeOptionalString(process.env.LOCALAPPDATA) ??
          join(os.homedir(), "AppData", "Local"))
        : (normalizeOptionalString(process.env.XDG_CACHE_HOME) ?? join(os.homedir(), ".cache"));
  const candidates = [join(defaultCache, "ms-playwright")];
  if (configured === "0") {
    try {
      const packageRoot = path.dirname(
        fileURLToPath(import.meta.resolve("playwright-core/package.json")),
      );
      candidates.unshift(join(packageRoot, ".local-browsers"));
    } catch {
      // Missing Playwright must not hide an independently installed default cache.
    }
  } else if (configured) {
    candidates.unshift(configured);
  }
  const base = getPlaywrightEnv("INIT_CWD") || process.cwd();
  return [...new Set(candidates.map((candidate) => pathApi.resolve(base, candidate)))];
}

/** The cache is only a fallback; explicit executables and installed browsers keep precedence. */
export function findPlaywrightChromiumExecutable(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    return null;
  }
  const join = platform === "win32" ? path.win32.join : path.join;
  // Playwright selects native Apple silicon even when Node runs under Rosetta.
  const macArm64 = platform === "darwin" && os.cpus().some((cpu) => cpu.model.includes("Apple"));
  const chromiumPaths =
    platform === "linux"
      ? [
          [`chrome-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`, "chrome"],
          ["chrome-linux", "chrome"],
        ]
      : platform === "darwin"
        ? [
            [
              `chrome-mac-${macArm64 ? "arm64" : "x64"}`,
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ],
            ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
          ]
        : [
            ["chrome-win64", "chrome.exe"],
            ["chrome-win", "chrome.exe"],
          ];
  // Switching an existing full-Chromium profile to shell can discard localStorage.
  // Shell is an explicit executablePath choice for a separate managed profile.
  for (const cache of cachePaths(platform)) {
    let entries: string[];
    try {
      entries = fs
        .readdirSync(cache)
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-")) {
        continue;
      }
      for (const segments of chromiumPaths) {
        const candidate = join(cache, entry, ...segments);
        if (executableFileExistsSync(candidate, platform)) {
          return { kind: "chromium", path: candidate };
        }
      }
    }
  }
  return null;
}
