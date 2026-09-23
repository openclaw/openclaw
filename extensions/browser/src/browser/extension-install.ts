import fs from "node:fs/promises";
import path from "node:path";
import {
  assertCurrentNativeHostLaunchContext,
  assertExpectedNativeHostProfile,
  NativeHostSetupContextError,
  type NativeHostRegistrationStatus,
} from "./extension-install-context.js";
import {
  chromeStoreInstallRequests,
  type ChromeStoreInstallRequest,
  FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
  FOUNDATION_CHROME_WEB_STORE_URL,
  requestChromeStoreInstall,
} from "./extension-install-external.js";
import {
  approvedInstallRealpaths,
  assertOwnedPath,
  chromeProductRoots,
  discoverChromeExtensionIds,
  ensurePrivateDirectory,
  type DiscoveredChromeExtension,
  type DiscoveredChromeStoreExtension,
  type ExtensionInstallDeps,
  generateChromeExtensionIdForPath,
  inspectInstalledCopy,
  installStableChromeExtension,
  pathInfo,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import { inspectRegistration, installRegistration } from "./extension-install-registration.js";
import { isValidProfileName } from "./profiles.js";
export { NativeHostSetupContextError } from "./extension-install-context.js";
export {
  repairChromeExtensionNativeHosts,
  resolveNativeHostPath,
  uninstallChromeExtensionNativeHosts,
} from "./extension-install-registration.js";

const BROWSER_EXTENSION_INSTALL_WAIT_DEFAULT_MS = 30_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS = 1_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS = 120_000;
export {
  FOUNDATION_CHROME_WEB_STORE_URL,
  removeChromeStoreInstallRequests,
} from "./extension-install-external.js";

export type BrowserExtensionStatus = {
  platform: NodeJS.Platform;
  platformSupport: "automatic" | "manual_required";
  installedCopy: { path: string; present: boolean; owned: boolean };
  bundledPath: string;
  approvedPaths: string[];
  discovered: DiscoveredChromeExtension[];
  storeDiscovered: DiscoveredChromeStoreExtension[];
  storeInstallRequests: ChromeStoreInstallRequest[];
  registrations: NativeHostRegistrationStatus[];
  manualSetupRequired: boolean;
  issues: string[];
};

export function normalizeExtensionInstallWaitMs(value: unknown): number {
  if (value === undefined) {
    return BROWSER_EXTENSION_INSTALL_WAIT_DEFAULT_MS;
  }
  const parsed =
    typeof value === "number" || (typeof value === "string" && /^\d+$/u.test(value))
      ? Number(value)
      : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS ||
    parsed > BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS
  ) {
    throw new Error(
      `--wait-ms must be an integer from ${BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS} to ${BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS}`,
    );
  }
  return parsed;
}

/** Copy, pre-register Store plus deterministic IDs, then verify Chrome's recorded identity. */
export async function installChromeExtensionBootstrap(params: {
  bundledDir: string;
  pluginRoot: string;
  waitMs?: number;
  requestStoreInstall?: boolean;
  deps?: ExtensionInstallDeps;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  browserProfile?: string;
  nativeHostExecutable?: string;
  requireCurrentLaunchContext?: boolean;
  expectedRegistrations?: readonly NativeHostRegistrationStatus[];
}): Promise<BrowserExtensionStatus> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  if (params.browserProfile !== undefined && !isValidProfileName(params.browserProfile)) {
    throw new Error("Invalid native browser profile");
  }
  params.signal?.throwIfAborted();
  if (
    (params.requireCurrentLaunchContext || params.expectedRegistrations) &&
    platform !== "win32"
  ) {
    for (const root of chromeProductRoots(deps)) {
      const registration = await inspectRegistration(root, deps);
      if (params.requireCurrentLaunchContext) {
        assertCurrentNativeHostLaunchContext(registration, deps);
      }
      assertExpectedNativeHostProfile(registration, params.expectedRegistrations);
    }
    params.signal?.throwIfAborted();
  }
  const installed = await installStableChromeExtension(params.bundledDir, deps);
  if (platform === "win32" && process.platform !== "win32" && !deps.windowsNative) {
    return await browserExtensionStatus({ bundledDir: params.bundledDir, deps });
  }
  const approvedPaths = await approvedInstallRealpaths(installed, params.bundledDir);
  const predictedIds = [
    ...new Set(
      approvedPaths.map((candidate) => generateChromeExtensionIdForPath(candidate, platform)),
    ),
  ].toSorted();
  if (platform === "win32") {
    const { installWindowsNativeHost } = await import("./extension-windows-host.js");
    const windows = await installWindowsNativeHost({
      ...params,
      executable: params.nativeHostExecutable,
      extensionIds: predictedIds,
      deps,
    });
    // Keep the accepted post-mutation receipt: no automatic follow-up or retry can hide a partial result.
    return await browserExtensionStatus({ ...params, deps, windowsObservation: windows });
  }
  const preRegistrationIssues: string[] = [];
  let preRegisteredRoots = 0;
  for (const root of chromeProductRoots(deps)) {
    params.signal?.throwIfAborted();
    try {
      if (!(await pathInfo(root.userDataDir))) {
        if (platform !== "darwin" || root.product !== "chrome") {
          continue;
        }
        // First-launch preparation creates only documented host/request directories, not a profile.
        await ensurePrivateDirectory(root.userDataDir);
      }
      await assertOwnedPath(root.userDataDir, "directory");
      params.signal?.throwIfAborted();
      await installRegistration({
        root,
        extensionIds: predictedIds,
        pluginRoot: params.pluginRoot,
        deps,
        browserProfile: params.browserProfile,
        signal: params.signal,
        requireCurrentLaunchContext: params.requireCurrentLaunchContext,
        expectedRegistrations: params.expectedRegistrations,
      });
      preRegisteredRoots += 1;
      params.onProgress?.(`Pre-registered the native host for ${root.label}.`);
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof NativeHostSetupContextError) {
        throw error;
      }
      preRegistrationIssues.push(
        `${root.label}: native host pre-registration refused (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    try {
      params.signal?.throwIfAborted();
      const request =
        params.requestStoreInstall === false
          ? undefined
          : await requestChromeStoreInstall(root, deps);
      if (request) {
        params.onProgress?.(
          `Requested the OpenClaw Store extension for ${root.label}. Restart Chrome if needed, then approve OpenClaw in chrome://extensions.`,
        );
      }
    } catch (error) {
      params.signal?.throwIfAborted();
      preRegistrationIssues.push(
        `${root.label}: Store installation request refused (${error instanceof Error ? error.message : String(error)}). Add OpenClaw directly: ${FOUNDATION_CHROME_WEB_STORE_URL}`,
      );
    }
  }
  if (preRegisteredRoots > 0) {
    params.onProgress?.(
      `Native bootstrap is ready. Add OpenClaw from the Chrome Web Store: ${FOUNDATION_CHROME_WEB_STORE_URL}. For development, load unpacked from ${installed}.`,
    );
  } else {
    preRegistrationIssues.push(
      "No native host was pre-registered. Resolve any pre-registration refusals above; if Chrome has not been launched yet, launch it first. Then run install again before loading the extension.",
    );
  }
  const waitMs = normalizeExtensionInstallWaitMs(params.waitMs);
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadline = now() + waitMs;
  let discovery = await discoverChromeExtensionIds({
    approvedDirs: approvedPaths,
    storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
    deps,
  });
  let announcedWait = false;
  while (
    discovery.discovered.length === 0 &&
    discovery.storeDiscovered.length === 0 &&
    now() < deadline
  ) {
    if (!announcedWait) {
      params.onProgress?.("Waiting for Chrome to verify the OpenClaw extension…");
      announcedWait = true;
    }
    params.signal?.throwIfAborted();
    await sleep(Math.min(500, Math.max(1, deadline - now())));
    params.signal?.throwIfAborted();
    discovery = await discoverChromeExtensionIds({
      approvedDirs: approvedPaths,
      storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
      deps,
    });
  }
  const status = await browserExtensionStatus({
    bundledDir: params.bundledDir,
    deps,
    requireCurrentLaunchContext: params.requireCurrentLaunchContext,
  });
  return {
    ...status,
    issues: [...new Set([...preRegistrationIssues, ...status.issues])],
  };
}

/** Read-only extension copy, profile discovery, and native registration report. */
export async function browserExtensionStatus(params: {
  bundledDir: string;
  pluginRoot?: string;
  nativeHostExecutable?: string;
  browserProfile?: string;
  signal?: AbortSignal;
  windowsObservation?: import("./extension-windows-host.js").WindowsHostProjection;
  requireCurrentLaunchContext?: boolean;
  deps?: ExtensionInstallDeps;
}): Promise<BrowserExtensionStatus> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const installedPath = stableChromeExtensionDir(deps);
  const installedCopy = await inspectInstalledCopy(installedPath);
  const bundledPath = await fs.realpath(params.bundledDir);
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  const approvedPaths = installedCopy.owned
    ? await approvedInstallRealpaths(installedPath, bundledPath)
    : [bundledPath];
  const discovery = await discoverChromeExtensionIds({
    approvedDirs: approvedPaths,
    storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
    deps,
  });
  const predictedIds = [
    ...new Set(
      approvedPaths.map((candidate) => generateChromeExtensionIdForPath(candidate, platform)),
    ),
  ].toSorted();
  const windows =
    platform === "win32" && (process.platform === "win32" || deps.windowsNative)
      ? (params.windowsObservation ??
        (await (
          await import("./extension-windows-host.js")
        ).inspectWindowsNativeHosts({
          deps,
          pluginRoot: params.pluginRoot,
          executable: params.nativeHostExecutable,
          extensionIds: predictedIds,
          browserProfile: params.browserProfile,
          signal: params.signal,
        })))
      : undefined;
  const registrations =
    platform === "win32"
      ? (windows?.registrations ?? [])
      : await Promise.all(
          chromeProductRoots(deps).map((root) => inspectRegistration(root, deps, predictedIds)),
        ).then((entries) =>
          entries.map((registration) => {
            if (params.requireCurrentLaunchContext) {
              assertCurrentNativeHostLaunchContext(registration, deps);
            }
            const {
              nativeHostPath: _nativeHostPath,
              launcherPath: _launcherPath,
              launchContext: _launchContext,
              ...entry
            } = registration;
            return entry;
          }),
        );
  const unavailableRegistration = registrations.some((registration) => {
    const productWasDiscovered =
      discovery.discovered.some((entry) => entry.product === registration.product) ||
      discovery.storeDiscovered.some((entry) => entry.product === registration.product);
    return productWasDiscovered && (registration.state !== "owned" || Boolean(registration.issue));
  });
  const storeInstallRequests =
    windows?.storeInstallRequests ?? (await chromeStoreInstallRequests(deps));
  return {
    platform,
    platformSupport:
      platform === "win32" && !registrations.length ? "manual_required" : "automatic",
    installedCopy: { path: installedPath, ...installedCopy },
    bundledPath: path.resolve(params.bundledDir),
    approvedPaths,
    discovered: discovery.discovered,
    storeDiscovered: discovery.storeDiscovered,
    storeInstallRequests,
    registrations,
    manualSetupRequired:
      (platform === "win32" && !registrations.length) ||
      (installedCopy.present && !installedCopy.owned) ||
      (discovery.discovered.length === 0 &&
        !discovery.storeDiscovered.some((entry) => entry.enabled)) ||
      discovery.identityMismatches.length > 0 ||
      unavailableRegistration,
    issues: [
      ...(installedCopy.present && !installedCopy.owned
        ? [`Chrome extension copy is not OpenClaw-owned: ${installedPath}`]
        : []),
      ...discovery.issues,
      ...(windows?.issues ?? []),
      ...storeInstallRequests.flatMap((entry) =>
        entry.issue ? [`${entry.browser}: ${entry.issue}`] : [],
      ),
      ...registrations.flatMap((entry) =>
        entry.issue ? [`${entry.browser}: ${entry.issue}`] : [],
      ),
    ],
  };
}

/** Resolve the installed stable copy when present, bundled source otherwise. */
export async function resolveChromeExtensionLoadPath(
  bundledDir: string,
  deps: ExtensionInstallDeps = {},
): Promise<string> {
  const installedPath = stableChromeExtensionDir(deps);
  const installed = await inspectInstalledCopy(installedPath);
  if (installed.present) {
    if (!installed.owned) {
      throw new Error(`Refusing foreign Chrome extension directory: ${installedPath}`);
    }
    return await fs.realpath(installedPath);
  }
  const bundledPath = await fs.realpath(path.resolve(bundledDir));
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  return bundledPath;
}
