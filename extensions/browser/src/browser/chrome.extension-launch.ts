import { readBrowserVersion } from "./chrome.executable-probe.js";
import {
  resolveBrowserExecutableForPlatform,
  type BrowserExecutable,
} from "./chrome.executables.js";
import { findPlaywrightChromiumExecutable } from "./chrome.playwright-cache.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import type { ExtensionDeclaration } from "./extension-launch-state.js";

/** Select a full browser that honors unpacked extension launch flags. */
export function resolveExtensionLaunchExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): BrowserExecutable {
  const executablePath = profile.executablePath ?? resolved.executablePath;
  const exe = executablePath
    ? resolveBrowserExecutableForPlatform({ ...resolved, executablePath }, process.platform)
    : findPlaywrightChromiumExecutable(process.platform);
  if (!exe) {
    throw new Error(
      "Managed extensions require a full Playwright Chromium installation. Install Chromium with the bundled playwright-core CLI, or set browser.executablePath to Chromium/Chrome for Testing.",
    );
  }
  // Branded Chrome ignores unpacked-extension flags; fail before launching it.
  if (
    exe.kind !== "chromium" &&
    !/^(Chromium|Google Chrome for Testing)\b/.test(readBrowserVersion(exe.path) ?? "")
  ) {
    throw new Error(
      "Managed extensions require full Chromium or Chrome for Testing. Branded Chrome ignores --load-extension; install Playwright Chromium or choose browser.executablePath.",
    );
  }
  return exe;
}

/** Keep the vetted declaration authoritative over caller-provided extension flags. */
export function extensionLaunchArgs(
  declaration: ExtensionDeclaration | undefined,
  extraArgs: string[],
): string[] {
  if (!declaration) {
    return [];
  }
  if (
    extraArgs.some((arg) =>
      /^(--load-extension|--disable-extensions|--disable-extensions-except)(=|$)/.test(arg),
    )
  ) {
    throw new Error(
      "Remove extension launch flags from browser.extraArgs before requesting a managed extension.",
    );
  }
  return [
    `--disable-extensions-except=${declaration.extension.unpackedPath}`,
    `--load-extension=${declaration.extension.unpackedPath}`,
  ];
}

/** Resolve the configured or platform-default browser without extension policy. */
export function resolveBrowserExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(
    { ...resolved, executablePath: profile.executablePath ?? resolved.executablePath },
    process.platform,
  );
}

/** Choose the normal browser or enforce extension-capable launch prerequisites. */
export function resolveChromeLaunchExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  declaration?: ExtensionDeclaration,
): BrowserExecutable {
  const exe = declaration
    ? resolveExtensionLaunchExecutable(resolved, profile)
    : resolveBrowserExecutable(resolved, profile);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }
  return exe;
}
