import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  chromeStoreInstallRequests,
  type ChromeStoreInstallRequest,
  FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
  FOUNDATION_CHROME_WEB_STORE_URL,
  requestChromeStoreInstall,
} from "./extension-install-external.js";
import { assertPrivateNativeHostFile, assertNativeHostTarget } from "./extension-install-files.js";
import {
  assertOwnedPath,
  chromeProductRoots,
  type ChromeProduct,
  type ChromeProductRoot,
  discoverChromeExtensionIds,
  type DiscoveredChromeExtension,
  type DiscoveredChromeStoreExtension,
  ensurePrivateDirectory,
  type ExtensionInstallDeps,
  generateChromeExtensionIdForPath,
  inspectInstalledCopy,
  installStableChromeExtension,
  pathInfo,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import {
  expectedOriginsForExtensionIds,
  isSafeOriginMigration,
} from "./extension-install-origins.js";
import { BROWSER_NATIVE_HOST_DESCRIPTION as NATIVE_HOST_DESCRIPTION } from "./extension-native-host.constants.js";
import { BROWSER_NATIVE_HOST_NAME } from "./extension-native-host.js";
import { isValidProfileName } from "./profiles.js";

const OWNED_LAUNCHER_MARKER = "# OpenClaw native messaging bootstrap v1";
const BROWSER_EXTENSION_INSTALL_WAIT_DEFAULT_MS = 30_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS = 1_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS = 120_000;
export {
  FOUNDATION_CHROME_WEB_STORE_URL,
  removeChromeStoreInstallRequests,
} from "./extension-install-external.js";

type NativeHostRegistrationStatus = {
  product: ChromeProduct;
  browser: string;
  manifestPath: string;
  extensionIds: string[];
  state: "missing" | "owned" | "foreign" | "invalid" | null;
  issue?: string;
  browserProfile?: string;
};

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

function nativeMessagingRoot(deps: ExtensionInstallDeps = {}): string {
  return path.join(resolveInstallStateDir(deps), "browser", "native-messaging");
}

function resolveInstallStateDir(deps: ExtensionInstallDeps): string {
  return path.resolve(deps.stateDir ?? resolveStateDir(deps.env));
}

function resolveInstallConfigPath(deps: ExtensionInstallDeps): string | undefined {
  const env = deps.env ?? process.env;
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit ? resolveStateDir({ ...env, OPENCLAW_STATE_DIR: explicit }) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function resolveNativeHostPath(
  pluginRoot: string,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    return await fs.realpath(explicit);
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const candidates = [path.join(resolvedPluginRoot, "native-host-entry.js")];
  let cursor = resolvedPluginRoot;
  for (;;) {
    candidates.push(path.join(cursor, "dist", "extensions", "browser", "native-host-entry.js"));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  for (const candidate of candidates) {
    if (await pathInfo(candidate)) {
      return await fs.realpath(candidate);
    }
  }
  throw new Error("Could not resolve the built browser native-host entrypoint; run pnpm build.");
}

function launcherPathForManifest(manifestPath: string, deps: ExtensionInstallDeps): string {
  const suffix = crypto.createHash("sha256").update(manifestPath).digest("hex").slice(0, 16);
  return path.join(nativeMessagingRoot(deps), `${BROWSER_NATIVE_HOST_NAME}.${suffix}.sh`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseOwnedLauncherTargets(params: {
  content: string;
  manifestPath: string;
  launcherPath: string;
  origins: string[];
}): { targets: string[]; browserProfile?: string } | undefined {
  const quotedValue = String.raw`'(?:[^'\r\n]|'"'"')*'`;
  const command = [
    `(${quotedValue})`,
    `(${quotedValue})`,
    escapeRegExp(shellQuote("--manifest")),
    escapeRegExp(shellQuote(params.manifestPath)),
    escapeRegExp(shellQuote("--launcher")),
    escapeRegExp(shellQuote(params.launcherPath)),
    ...params.origins.flatMap((origin) => [
      escapeRegExp(shellQuote("--expected-origin")),
      escapeRegExp(shellQuote(origin)),
    ]),
  ].join(" ");
  const profileArgument = `(?: ${escapeRegExp(shellQuote("--browser-profile"))} (${quotedValue}))?`;
  const pattern = new RegExp(
    `^#!/bin/sh\\n${escapeRegExp(OWNED_LAUNCHER_MARKER)}\\nexport OPENCLAW_STATE_DIR=${quotedValue}\\n(?:export OPENCLAW_CONFIG_PATH=${quotedValue}\\n)?exec ${command}${profileArgument} "\\$@"\\n$`,
    "u",
  );
  const match = pattern.exec(params.content);
  if (!match) {
    return undefined;
  }
  const decode = (value: string) => value.slice(1, -1).replaceAll(`'"'"'`, "'");
  const browserProfile = match[3] === undefined ? undefined : decode(match[3]);
  if (browserProfile !== undefined && !isValidProfileName(browserProfile)) {
    return undefined;
  }
  return {
    targets: [decode(match[1]!), decode(match[2]!)],
    ...(browserProfile === undefined ? {} : { browserProfile }),
  };
}

async function resolveLauncherInstall(params: {
  manifestPath: string;
  pluginRoot: string;
  extensionIds: string[];
  deps: ExtensionInstallDeps;
  browserProfile?: string;
}): Promise<{ path: string; content: string }> {
  const launcherPath = launcherPathForManifest(params.manifestPath, params.deps);
  const nodePath = await fs.realpath(params.deps.nodePath ?? process.execPath);
  const nativeHostPath = await resolveNativeHostPath(params.pluginRoot, params.deps.nativeHostPath);
  await assertNativeHostTarget(nodePath, fs.constants.X_OK);
  await assertNativeHostTarget(nativeHostPath, fs.constants.R_OK);
  const command = [
    nodePath,
    nativeHostPath,
    "--manifest",
    params.manifestPath,
    "--launcher",
    launcherPath,
    ...expectedOriginsForExtensionIds(params.extensionIds).flatMap((origin) => [
      "--expected-origin",
      origin,
    ]),
  ];
  if (params.browserProfile) {
    command.push("--browser-profile", params.browserProfile);
  }
  const configPath = resolveInstallConfigPath(params.deps);
  return {
    path: launcherPath,
    content: [
      "#!/bin/sh",
      OWNED_LAUNCHER_MARKER,
      `export OPENCLAW_STATE_DIR=${shellQuote(resolveInstallStateDir(params.deps))}`,
      ...(configPath ? [`export OPENCLAW_CONFIG_PATH=${shellQuote(configPath)}`] : []),
      `exec ${command.map(shellQuote).join(" ")} "$@"`,
      "",
    ].join("\n"),
  };
}

async function inspectRegistration(
  root: ChromeProductRoot,
  deps: ExtensionInstallDeps,
  expectedPathExtensionIds?: string[],
): Promise<NativeHostRegistrationStatus> {
  const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
  if (!(await pathInfo(manifestPath))) {
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: [],
      state: "missing",
    };
  }
  try {
    await assertPrivateNativeHostFile(manifestPath, false, deps.platform ?? process.platform);
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest is not an object");
    }
    const manifest = parsed as { name?: unknown; path?: unknown; allowed_origins?: unknown };
    const expectedLauncher = launcherPathForManifest(manifestPath, deps);
    const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
    const ids = origins.flatMap((origin) => {
      const match = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(String(origin));
      return match?.[1] ? [match[1]] : [];
    });
    if (manifest.name !== BROWSER_NATIVE_HOST_NAME || manifest.path !== expectedLauncher) {
      return {
        product: root.product,
        browser: root.label,
        manifestPath,
        extensionIds: ids,
        state: "foreign",
        issue: "same host name is registered to a foreign manifest or launcher",
      };
    }
    const exactKeys = ["name", "description", "path", "type", "allowed_origins"];
    const stringOrigins = origins.filter((origin): origin is string => typeof origin === "string");
    const validOrigins =
      origins.length > 0 &&
      origins.length === stringOrigins.length &&
      stringOrigins.every((origin) => /^chrome-extension:\/\/[a-p]{32}\/$/u.test(origin)) &&
      new Set(origins).size === origins.length;
    const canonicalOrigins = [...stringOrigins].toSorted();
    const expectedOrigins = expectedPathExtensionIds
      ? expectedOriginsForExtensionIds(expectedPathExtensionIds)
      : null;
    if (
      Object.keys(manifest).length !== exactKeys.length ||
      !exactKeys.every((key) => Object.hasOwn(manifest, key)) ||
      (manifest as { description?: unknown }).description !== NATIVE_HOST_DESCRIPTION ||
      (manifest as { type?: unknown }).type !== "stdio" ||
      !validOrigins ||
      JSON.stringify(origins) !== JSON.stringify(canonicalOrigins)
    ) {
      throw new Error("native host manifest does not contain exact allowed origins");
    }
    await assertPrivateNativeHostFile(expectedLauncher, true, deps.platform ?? process.platform);
    const launcherTargets = parseOwnedLauncherTargets({
      content: await fs.readFile(expectedLauncher, "utf8"),
      manifestPath,
      launcherPath: expectedLauncher,
      origins: stringOrigins,
    });
    if (!launcherTargets) {
      throw new Error("native host launcher and manifest origins do not match");
    }
    // Recover selection only after validating the private manifest and its exact
    // launcher. A supported bundle-path migration changes readiness, not ownership.
    let issue: string | undefined;
    if (
      expectedPathExtensionIds !== undefined &&
      JSON.stringify(origins) !== JSON.stringify(expectedOrigins)
    ) {
      if (!isSafeOriginMigration(ids, expectedPathExtensionIds)) {
        throw new Error("native host manifest does not contain exact allowed origins");
      }
      issue =
        "registered native host origins require a supported path migration; run openclaw browser extension install";
    }
    // Removed package versions also remain repairable without losing saved selection.
    try {
      for (const [index, target] of launcherTargets.targets.entries()) {
        await assertNativeHostTarget(target, index === 0 ? fs.constants.X_OK : fs.constants.R_OK);
      }
    } catch {
      issue ??=
        "registered native host runtime or entry is unavailable or unsafe; run openclaw browser extension install";
    }
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: ids.toSorted(),
      state: "owned",
      issue,
      ...(launcherTargets.browserProfile === undefined
        ? {}
        : { browserProfile: launcherTargets.browserProfile }),
    };
  } catch (error) {
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: [],
      state: "invalid",
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installRegistration(params: {
  root: ChromeProductRoot;
  extensionIds: string[];
  pluginRoot: string;
  deps: ExtensionInstallDeps;
  browserProfile?: string;
  signal?: AbortSignal;
}): Promise<NativeHostRegistrationStatus> {
  const { root, extensionIds, deps } = params;
  const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
  const existing = await inspectRegistration(root, deps);
  if (existing.state === "foreign" || existing.state === "invalid") {
    throw new Error(`Refusing to overwrite ${existing.state} native host: ${manifestPath}`);
  }
  const desiredOrigins = expectedOriginsForExtensionIds(extensionIds);
  if (
    existing.state === "owned" &&
    JSON.stringify(existing.extensionIds.map((id) => `chrome-extension://${id}/`)) !==
      JSON.stringify(desiredOrigins) &&
    !isSafeOriginMigration(existing.extensionIds, extensionIds)
  ) {
    throw new Error(`Refusing to overwrite owned native host with unexpected allowed origins`);
  }
  params.signal?.throwIfAborted();
  await ensurePrivateDirectory(nativeMessagingRoot(deps));
  params.signal?.throwIfAborted();
  await ensurePrivateDirectory(root.nativeManifestDir);
  const launcher = await resolveLauncherInstall({
    manifestPath,
    pluginRoot: params.pluginRoot,
    extensionIds,
    deps,
    browserProfile: params.browserProfile ?? existing.browserProfile,
  });
  const launcherPath = launcher.path;
  if (await pathInfo(launcherPath)) {
    await assertOwnedPath(launcherPath, "file");
    const existingLauncher = await fs.readFile(launcherPath, "utf8");
    if (!existingLauncher.includes(OWNED_LAUNCHER_MARKER)) {
      throw new Error(`Refusing to overwrite foreign native host launcher: ${launcherPath}`);
    }
    if (existingLauncher !== launcher.content) {
      params.signal?.throwIfAborted();
      await replaceFileAtomic({ filePath: launcherPath, content: launcher.content, mode: 0o700 });
    }
  } else {
    params.signal?.throwIfAborted();
    await fs.writeFile(launcherPath, launcher.content, { mode: 0o700, flag: "wx" });
  }
  params.signal?.throwIfAborted();
  if (process.platform !== "win32") {
    await fs.chmod(launcherPath, 0o700);
  }
  const manifest = {
    name: BROWSER_NATIVE_HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: expectedOriginsForExtensionIds(extensionIds),
  };
  params.signal?.throwIfAborted();
  await replaceFileAtomic({
    filePath: manifestPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    mode: 0o600,
  });
  return await inspectRegistration(root, deps, extensionIds);
}

async function approvedInstallRealpaths(installed: string, bundled: string): Promise<string[]> {
  const installedPath = await fs.realpath(installed);
  const bundledPath = await fs.realpath(bundled);
  await assertOwnedPath(installedPath, "directory");
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  return [...new Set([installedPath, bundledPath])];
}

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
}): Promise<BrowserExtensionStatus> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  if (params.browserProfile !== undefined && !isValidProfileName(params.browserProfile)) {
    throw new Error("Invalid native browser profile");
  }
  params.signal?.throwIfAborted();
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
      });
      preRegisteredRoots += 1;
      params.onProgress?.(`Pre-registered the native host for ${root.label}.`);
    } catch (error) {
      params.signal?.throwIfAborted();
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
  const status = await browserExtensionStatus({ bundledDir: params.bundledDir, deps });
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

/** Remove only registrations and launchers that carry OpenClaw ownership. */
export async function uninstallChromeExtensionNativeHosts(
  params: {
    deps?: ExtensionInstallDeps;
    pluginRoot?: string;
    nativeHostExecutable?: string;
    browserProfile?: string;
    removeStore?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ removed: string[]; refused: string[]; manualRequired: boolean }> {
  const deps = params.deps ?? {};
  if ((deps.platform ?? process.platform) === "win32") {
    return process.platform === "win32" || deps.windowsNative
      ? (await import("./extension-windows-host.js")).uninstallWindowsNativeHosts({
          ...params,
          executable: params.nativeHostExecutable,
        })
      : { removed: [], refused: [], manualRequired: true };
  }
  if (params.removeStore) {
    throw new Error("Use uninstall-store for macOS Store requests.");
  }
  const removed: string[] = [];
  const refused: string[] = [];
  for (const root of chromeProductRoots(deps)) {
    const status = await inspectRegistration(root, deps);
    if (status.state === "missing") {
      continue;
    }
    if (status.state !== "owned") {
      refused.push(status.manifestPath);
      continue;
    }
    const launcherPath = launcherPathForManifest(status.manifestPath, deps);
    const launcher = await pathInfo(launcherPath);
    if (launcher) {
      await assertOwnedPath(launcherPath, "file");
      if (!(await fs.readFile(launcherPath, "utf8")).includes(OWNED_LAUNCHER_MARKER)) {
        refused.push(launcherPath);
        continue;
      }
    }
    await fs.unlink(status.manifestPath);
    removed.push(status.manifestPath);
    if (launcher) {
      await fs.unlink(launcherPath);
      removed.push(launcherPath);
    }
  }
  return { removed, refused, manualRequired: false };
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
