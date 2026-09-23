/** Discover installed Playwright browsers without loading its runtime or downloading anything. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserExecutable } from "./chrome.executable-types.js";

function cachePaths(platform: NodeJS.Platform): string[] {
  const join = platform === "win32" ? path.win32.join : path.join;
  const configured = normalizeOptionalString(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const defaultCache =
    platform === "darwin"
      ? join(os.homedir(), "Library", "Caches")
      : platform === "win32"
        ? (normalizeOptionalString(process.env.LOCALAPPDATA) ??
          join(os.homedir(), "AppData", "Local"))
        : (normalizeOptionalString(process.env.XDG_CACHE_HOME) ?? join(os.homedir(), ".cache"));
  return [
    ...new Set([
      configured && configured !== "0" ? configured : null,
      join(defaultCache, "ms-playwright"),
    ]),
  ].filter((entry): entry is string => entry !== null);
}

/** The cache is only a fallback; explicit executables and installed browsers keep precedence. */
export function findPlaywrightChromiumExecutable(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    return null;
  }
  const join = platform === "win32" ? path.win32.join : path.join;
  const chromiumPaths =
    platform === "linux"
      ? [
          [`chrome-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`, "chrome"],
          ["chrome-linux", "chrome"],
        ]
      : platform === "darwin"
        ? [
            [
              `chrome-mac-${process.arch === "arm64" ? "arm64" : "x64"}`,
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
        try {
          if (!fs.statSync(candidate).isFile()) {
            continue;
          }
          fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
          return { kind: "chromium", path: candidate };
        } catch {
          // A stale or incomplete cache entry is not an installed browser.
        }
      }
    }
  }
  return null;
}
