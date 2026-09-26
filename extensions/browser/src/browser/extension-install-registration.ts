import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertCurrentNativeHostLaunchContext,
  assertExpectedNativeHostProfile,
  NativeHostSetupContextError,
  resolveInstallConfigPath,
  resolveInstallStateDir,
  type NativeHostLaunchContext,
  type NativeHostRegistrationStatus,
} from "./extension-install-context.js";
import { FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID } from "./extension-install-external.js";
import {
  approvedInstallRealpaths,
  assertOwnedPath,
  chromeProductRoots,
  type ChromeProductRoot,
  ensurePrivateDirectory,
  type ExtensionInstallDeps,
  generateChromeExtensionIdForPath,
  inspectInstalledCopy,
  pathInfo,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import {
  BROWSER_NATIVE_HOST_DESCRIPTION as NATIVE_HOST_DESCRIPTION,
  BROWSER_NATIVE_HOST_NAME,
} from "./extension-native-host.constants.js";
import { isValidProfileName } from "./profiles.js";

const OWNED_LAUNCHER_MARKER = "# OpenClaw native messaging bootstrap v1";

function nativeMessagingRoot(deps: ExtensionInstallDeps = {}): string {
  return path.join(resolveInstallStateDir(deps), "browser", "native-messaging");
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

function versionedLauncherPath(basePath: string, content: string): string {
  return `${basePath.slice(0, -3)}.${crypto.createHash("sha256").update(content).digest("hex")}.sh`;
}

function expectedExtensionIds(extensionIds: string[]): string[] {
  // The Store ID also authorizes trusted unpacked builds that preserve it;
  // it never proves that an arbitrary extension path is OpenClaw-owned.
  return [...new Set([...extensionIds, FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID])].toSorted();
}

function expectedOriginsForExtensionIds(extensionIds: string[]): string[] {
  return expectedExtensionIds(extensionIds).map(
    (extensionId) => `chrome-extension://${extensionId}/`,
  );
}

function pathDerivedExtensionIds(extensionIds: string[]): string[] {
  return extensionIds.filter(
    (extensionId) => extensionId !== FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
  );
}

function isSafeOriginMigration(existingIds: string[], desiredPathIds: string[]): boolean {
  const existingPathIds = pathDerivedExtensionIds(existingIds).toSorted();
  const desiredIds = [...new Set(desiredPathIds)].toSorted();
  if (JSON.stringify(existingPathIds) === JSON.stringify(desiredIds)) {
    return true;
  }
  const removed = existingPathIds.filter((id) => !desiredIds.includes(id));
  const added = desiredIds.filter((id) => !existingPathIds.includes(id));
  const overlap = existingPathIds.some((id) => desiredIds.includes(id));
  return (
    existingPathIds.length === desiredIds.length &&
    removed.length === 1 &&
    added.length === 1 &&
    overlap
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseOwnedLauncher(params: {
  content: string;
  manifestPath: string;
  launcherPath: string;
  origins: string[];
}): { targets: string[]; context: NativeHostLaunchContext; browserProfile?: string } | undefined {
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
    `^#!/bin/sh\\n${escapeRegExp(OWNED_LAUNCHER_MARKER)}\\nexport OPENCLAW_STATE_DIR=(${quotedValue})\\n(?:export OPENCLAW_CONFIG_PATH=(${quotedValue})\\n)?exec ${command}${profileArgument} "\\$@"\\n$`,
    "u",
  );
  const [stateDir, configPath, nodePath, nativeHostPath, savedProfile] =
    pattern.exec(params.content)?.slice(1) ?? [];
  if (stateDir === undefined || nodePath === undefined || nativeHostPath === undefined) {
    return undefined;
  }
  // Decode only shellQuote's words after the entire ownership grammar matches.
  const decode = (value: string) => value.slice(1, -1).replaceAll(`'"'"'`, "'");
  const browserProfile = savedProfile === undefined ? undefined : decode(savedProfile);
  if (browserProfile !== undefined && !isValidProfileName(browserProfile)) {
    return undefined;
  }
  return {
    targets: [decode(nodePath), decode(nativeHostPath)],
    context: {
      stateDir: decode(stateDir),
      configPath: configPath === undefined ? undefined : decode(configPath),
    },
    ...(browserProfile === undefined ? {} : { browserProfile }),
  };
}

async function assertPrivateNativeHostFile(
  target: string,
  executable: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  await assertOwnedPath(target, "file");
  if (platform === "win32") {
    return;
  }
  const mode = (await fs.lstat(target)).mode & 0o777;
  if ((mode & 0o077) !== 0 || (executable && (mode & 0o100) === 0)) {
    throw new Error("native host file has unsafe mode");
  }
}

async function assertNativeHostTarget(target: string, accessMode: number): Promise<void> {
  // Registered targets must not depend on Chrome's working directory.
  if (!path.isAbsolute(target)) {
    throw new Error("native host target must be an absolute path");
  }
  await assertOwnedPath(target, "file", { allowRootOwner: true });
  await fs.access(target, accessMode);
}

async function resolveLauncherInstall(params: {
  manifestPath: string;
  pluginRoot: string;
  extensionIds: string[];
  deps: ExtensionInstallDeps;
  launchContext?: NativeHostLaunchContext;
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
  const context = params.launchContext ?? {
    stateDir: resolveInstallStateDir(params.deps),
    configPath: resolveInstallConfigPath(params.deps),
  };
  const content = [
    "#!/bin/sh",
    OWNED_LAUNCHER_MARKER,
    `export OPENCLAW_STATE_DIR=${shellQuote(context.stateDir)}`,
    ...(context.configPath !== undefined
      ? [`export OPENCLAW_CONFIG_PATH=${shellQuote(context.configPath)}`]
      : []),
    `exec ${command.map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
  const versionedPath = versionedLauncherPath(launcherPath, content);
  return {
    path: versionedPath,
    content: content.replace(
      ` '--launcher' ${shellQuote(launcherPath)}`,
      () => ` '--launcher' ${shellQuote(versionedPath)}`,
    ),
  };
}

export async function inspectRegistration(
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
    const manifest = asNullableRecord(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    if (!manifest) {
      throw new Error("manifest is not an object");
    }
    const baseLauncher = launcherPathForManifest(manifestPath, deps);
    const expectedLauncher = typeof manifest.path === "string" ? manifest.path : "";
    const versionedPathPattern = new RegExp(
      `^${escapeRegExp(baseLauncher.slice(0, -3))}\\.[a-f0-9]{64}\\.sh$`,
      "u",
    );
    const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
    const ids = origins.flatMap((origin) => {
      const match = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(String(origin));
      return match?.[1] ? [match[1]] : [];
    });
    if (
      manifest.name !== BROWSER_NATIVE_HOST_NAME ||
      (expectedLauncher !== baseLauncher && !versionedPathPattern.test(expectedLauncher))
    ) {
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
      manifest.description !== NATIVE_HOST_DESCRIPTION ||
      manifest.type !== "stdio" ||
      !validOrigins ||
      JSON.stringify(origins) !== JSON.stringify(canonicalOrigins)
    ) {
      throw new Error("native host manifest does not contain exact allowed origins");
    }
    await assertPrivateNativeHostFile(expectedLauncher, true, deps.platform ?? process.platform);
    const launcherContent = await fs.readFile(expectedLauncher, "utf8");
    const canonicalContent = launcherContent.replace(
      ` '--launcher' ${shellQuote(expectedLauncher)}`,
      () => ` '--launcher' ${shellQuote(baseLauncher)}`,
    );
    // Existing fixed launchers migrate on install. Versioned launchers are immutable;
    // the manifest rename is the single publication point for a matching pair.
    if (
      expectedLauncher !== baseLauncher &&
      versionedLauncherPath(baseLauncher, canonicalContent) !== expectedLauncher
    ) {
      throw new Error("native host launcher content does not match its immutable identity");
    }
    const parsedLauncher = parseOwnedLauncher({
      content: launcherContent,
      manifestPath,
      launcherPath: expectedLauncher,
      origins: stringOrigins,
    });
    if (!parsedLauncher) {
      throw new Error("native host launcher and manifest origins do not match");
    }
    // Recover selection only from the verified manifest/launcher pair. A supported
    // bundle relocation changes readiness, not ownership or saved selection.
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
    try {
      for (const [index, target] of parsedLauncher.targets.entries()) {
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
      nativeHostPath: parsedLauncher.targets[1],
      launcherPath: expectedLauncher,
      launchContext: parsedLauncher.context,
      issue,
      ...(parsedLauncher.browserProfile === undefined
        ? {}
        : { browserProfile: parsedLauncher.browserProfile }),
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

export async function installRegistration(params: {
  root: ChromeProductRoot;
  extensionIds: string[];
  pluginRoot: string;
  deps: ExtensionInstallDeps;
  expectedNativeHostPath?: string;
  browserProfile?: string;
  signal?: AbortSignal;
  requireCurrentLaunchContext?: boolean;
  expectedRegistrations?: readonly NativeHostRegistrationStatus[];
}): Promise<NativeHostRegistrationStatus> {
  const { root, extensionIds, deps } = params;
  const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
  const existing = await inspectRegistration(root, deps);
  assertExpectedNativeHostProfile(existing, params.expectedRegistrations);
  if (existing.state === "foreign" || existing.state === "invalid") {
    throw new Error(`Refusing to overwrite ${existing.state} native host: ${manifestPath}`);
  }
  if (params.requireCurrentLaunchContext) {
    assertCurrentNativeHostLaunchContext(existing, deps);
  }
  if (
    params.expectedNativeHostPath !== undefined &&
    existing.nativeHostPath !== params.expectedNativeHostPath
  ) {
    throw new Error("Native host target changed before repair; inspect it again.");
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
    // Relocation replaces package targets, never the registered profile/config selection.
    launchContext:
      params.requireCurrentLaunchContext || params.expectedNativeHostPath !== undefined
        ? existing.launchContext
        : undefined,
    browserProfile: params.browserProfile ?? existing.browserProfile,
  });
  const launcherPath = launcher.path;
  const previousManifest =
    existing.state === "owned" ? await fs.readFile(manifestPath, "utf8") : undefined;
  const previousLauncher = existing.launcherPath
    ? { path: existing.launcherPath, content: await fs.readFile(existing.launcherPath, "utf8") }
    : null;
  let createdLauncher = false;
  if (await pathInfo(launcherPath)) {
    await assertOwnedPath(launcherPath, "file");
    const existingLauncher = await fs.readFile(launcherPath, "utf8");
    if (existingLauncher !== launcher.content) {
      throw new Error(
        `Refusing to overwrite changed immutable native host launcher: ${launcherPath}`,
      );
    }
  } else {
    params.signal?.throwIfAborted();
    await replaceFileAtomic({ filePath: launcherPath, content: launcher.content, mode: 0o700 });
    createdLauncher = true;
  }
  const manifest = {
    name: BROWSER_NATIVE_HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: expectedOriginsForExtensionIds(extensionIds),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    params.signal?.throwIfAborted();
    if (process.platform !== "win32") {
      await fs.chmod(launcherPath, 0o700);
    }
    params.signal?.throwIfAborted();
    await replaceFileAtomic({
      filePath: manifestPath,
      content: manifestContent,
      mode: 0o600,
      beforeRename:
        params.requireCurrentLaunchContext || params.expectedRegistrations
          ? async () => {
              params.signal?.throwIfAborted();
              const current = await inspectRegistration(root, deps);
              if (params.requireCurrentLaunchContext) {
                assertCurrentNativeHostLaunchContext(current, deps);
              }
              assertExpectedNativeHostProfile(current, params.expectedRegistrations);
              const currentManifest =
                current.state === "missing" ? undefined : await fs.readFile(manifestPath, "utf8");
              if (current.state !== existing.state || currentManifest !== previousManifest) {
                throw new NativeHostSetupContextError(
                  "Chrome's native host selection changed during setup. Inspect the registered OPENCLAW_CONFIG_PATH before trying again.",
                );
              }
              params.signal?.throwIfAborted();
            }
          : undefined,
    });
  } catch (error) {
    // Remove only this attempt's unreferenced candidate. An ambiguous publication
    // leaves it intact; the selected manifest remains the dependency authority.
    const observedManifest = await fs
      .readFile(manifestPath, "utf8")
      .catch((readError: unknown) =>
        asNullableRecord(readError)?.code === "ENOENT" ? undefined : null,
      );
    if (createdLauncher && observedManifest === previousManifest) {
      await assertPrivateNativeHostFile(launcherPath, true, deps.platform ?? process.platform);
      await fs.unlink(launcherPath);
    }
    throw error;
  }
  if (
    previousLauncher &&
    previousLauncher.path !== launcherPath &&
    (await fs.readFile(manifestPath, "utf8")) === manifestContent &&
    (await fs.readFile(previousLauncher.path, "utf8")) === previousLauncher.content
  ) {
    await assertPrivateNativeHostFile(
      previousLauncher.path,
      true,
      deps.platform ?? process.platform,
    );
    await fs.unlink(previousLauncher.path);
  }
  return await inspectRegistration(root, deps, extensionIds);
}

/** Inspect or refresh existing registrations without reading personal browser profiles. */
export async function repairChromeExtensionNativeHosts(params: {
  bundledDir: string;
  pluginRoot: string;
  fromNativeHostPath?: string;
  dryRun?: boolean;
  deps?: ExtensionInstallDeps;
}): Promise<{
  changes: string[];
  warnings: string[];
  registrations: NativeHostRegistrationStatus[];
  retainedNativeHostPaths: string[];
  retentionSafe: boolean;
  manualRequired: boolean;
}> {
  if (
    !params.dryRun &&
    (!params.fromNativeHostPath || !path.isAbsolute(params.fromNativeHostPath))
  ) {
    throw new Error(
      "Native host repair requires --from with the exact absolute registered entrypoint; use --dry-run to inspect targets.",
    );
  }
  const deps = params.deps ?? {};
  const fromNativeHostPath = params.fromNativeHostPath;
  const changes: string[] = [];
  const warnings: string[] = [];
  const registrations: NativeHostRegistrationStatus[] = [];
  const retained = new Set<string>();
  const manualRequired = (deps.platform ?? process.platform) === "win32";
  let retentionSafe = !manualRequired;
  for (const root of manualRequired ? [] : chromeProductRoots(deps)) {
    let registration = await inspectRegistration(root, deps);
    if (
      !params.dryRun &&
      fromNativeHostPath &&
      registration.state === "owned" &&
      registration.nativeHostPath === fromNativeHostPath
    ) {
      try {
        const installed = stableChromeExtensionDir(deps);
        if (!(await inspectInstalledCopy(installed)).owned) {
          throw new Error(
            "stable extension copy is not OpenClaw-owned; run browser extension install explicitly",
          );
        }
        const extensionIds = (await approvedInstallRealpaths(installed, params.bundledDir)).map(
          (candidate) =>
            generateChromeExtensionIdForPath(candidate, deps.platform ?? process.platform),
        );
        const launcher = await resolveLauncherInstall({
          manifestPath: registration.manifestPath,
          pluginRoot: params.pluginRoot,
          extensionIds,
          deps,
          launchContext: registration.launchContext,
          browserProfile: registration.browserProfile,
        });
        if (
          JSON.stringify(registration.extensionIds) !==
            JSON.stringify(expectedExtensionIds(extensionIds)) ||
          registration.launcherPath !== launcher.path
        ) {
          registration = await installRegistration({
            root,
            extensionIds,
            pluginRoot: params.pluginRoot,
            deps,
            expectedNativeHostPath: fromNativeHostPath,
          });
          changes.push(`Repaired ${root.label} OpenClaw native messaging registration.`);
        }
      } catch (error) {
        warnings.push(`${root.label} native host repair failed: ${String(error)}`);
        // Manifest publication owns the cutover. A failed publication keeps its
        // prior immutable launcher and dependency available for the next repair.
        retained.add(fromNativeHostPath);
        registration = await inspectRegistration(root, deps);
      }
    }
    registrations.push(registration);
    if (
      registration.state === "owned" &&
      registration.nativeHostPath &&
      path.isAbsolute(registration.nativeHostPath)
    ) {
      retained.add(registration.nativeHostPath);
    } else if (registration.state !== "missing") {
      retentionSafe = false;
      warnings.push(
        `${root.label} native host target cannot be established: ${registration.issue ?? registration.state}`,
      );
    }
  }
  return {
    changes,
    warnings,
    registrations: registrations.map(
      ({ launchContext: _launchContext, ...registration }) => registration,
    ),
    retainedNativeHostPaths: [...retained].toSorted(),
    retentionSafe,
    manualRequired,
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
    const launcherPath = status.launcherPath;
    if (!launcherPath) {
      refused.push(status.manifestPath);
      continue;
    }
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
