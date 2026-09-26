/** Managed local wrapper for Codex's reserved bundled marketplace. */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import {
  assertDirectoryIdentityStable,
  assertNotSymlink,
  directoryIdentityIsStable,
  prepareOwnedServiceParent,
} from "./computer-use-service-path.js";
import {
  codexUnifiedComputerUsePluginMatches,
  publishCodexUnifiedComputerUsePlugin,
  resolveCodexUnifiedComputerUseRuntime,
  UNIFIED_COMPUTER_USE_PLUGIN,
  type CodexUnifiedComputerUseRuntime,
} from "./computer-use-unified.js";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import { waitForCodexDesktopGeneration } from "./desktop-generation.js";

const MARKETPLACE_NAME = "openai-bundled";
const UNIFIED_SOURCE_FINGERPRINT = ".openclaw-unified-source-fingerprint";
const activeInstalls = new Map<
  string,
  { sourcePath: string; promise: Promise<string | undefined> }
>();

function resolveCodexManagedBundledMarketplacePath(codexHome: string): string {
  return path.join(codexHome, ".tmp", "bundled-marketplaces", MARKETPLACE_NAME);
}

export async function ensureCodexManagedBundledMarketplace(params: {
  codexHome: string;
  ownershipRoot: string;
  appServerCommand?: string;
  candidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  ownershipCandidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  computerUsePluginName?: string;
  computerUseMcpServerName?: string;
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  const candidates = params.candidates ?? resolveMacOSDesktopCodexAppPathCandidates();
  const source = await resolveCodexManagedBundledMarketplaceSource({ ...params, candidates });
  if (!source) {
    return undefined;
  }
  const unifiedRuntime = await resolveCodexUnifiedComputerUseRuntime(
    source,
    params.codexHome,
    params.computerUsePluginName,
    params.computerUseMcpServerName,
  );
  const parentPath = path.dirname(resolveCodexManagedBundledMarketplacePath(params.codexHome));
  const targetPath = path.join(parentPath, MARKETPLACE_NAME);
  const parent = await prepareOwnedServiceParent({
    ownershipRoot: params.ownershipRoot,
    codexHome: params.codexHome,
    targetParent: parentPath,
  });
  const physicalTargetPath = path.join(parent.realPath, MARKETPLACE_NAME);
  await assertNotSymlink(physicalTargetPath, "managed bundled marketplace");
  const active = activeInstalls.get(physicalTargetPath);
  if (active) {
    if (active.sourcePath === source.bundledMarketplacePath) {
      return await active.promise;
    }
    await active.promise.catch(() => undefined);
    return await ensureCodexManagedBundledMarketplace(params);
  }
  const install = publishManagedWrapper({
    parent,
    physicalTargetPath,
    targetPath,
    source,
    unifiedRuntime,
    ownershipCandidates: params.ownershipCandidates ?? candidates,
    assertCurrent: params.assertCurrent,
  });
  const activeEntry = { sourcePath: source.bundledMarketplacePath, promise: install };
  activeInstalls.set(physicalTargetPath, activeEntry);
  const clearActive = () => {
    if (activeInstalls.get(physicalTargetPath) === activeEntry) {
      activeInstalls.delete(physicalTargetPath);
    }
  };
  void install.then(clearActive, clearActive);
  return await install;
}

async function publishManagedWrapper(params: {
  parent: Awaited<ReturnType<typeof prepareOwnedServiceParent>>;
  physicalTargetPath: string;
  targetPath: string;
  source: MacOSDesktopCodexAppPathCandidate;
  unifiedRuntime?: CodexUnifiedComputerUseRuntime;
  ownershipCandidates: readonly MacOSDesktopCodexAppPathCandidate[];
  assertCurrent?: () => void;
}): Promise<string> {
  const { parent, physicalTargetPath, targetPath, source, ownershipCandidates, assertCurrent } =
    params;
  if (
    await wrapperMatches(physicalTargetPath, source.bundledMarketplacePath, params.unifiedRuntime)
  ) {
    return targetPath;
  }

  const stagingPath = await fs.mkdtemp(path.join(parent.realPath, `.${MARKETPLACE_NAME}.staging-`));
  const backupPath = path.join(
    parent.realPath,
    `.${MARKETPLACE_NAME}.backup-${process.pid}-${Date.now()}`,
  );
  let backupCreated = false;
  try {
    const manifestParent = path.join(stagingPath, ".agents", "plugins");
    await fs.mkdir(manifestParent, { recursive: true, mode: 0o700 });
    await fs.symlink(
      path.join(source.bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
      path.join(manifestParent, "marketplace.json"),
    );
    if (params.unifiedRuntime) {
      const pluginsPath = path.join(stagingPath, "plugins");
      await fs.mkdir(pluginsPath);
      for (const entry of await fs.readdir(path.join(source.bundledMarketplacePath, "plugins"))) {
        const target = path.join(pluginsPath, entry);
        if (entry === UNIFIED_COMPUTER_USE_PLUGIN) {
          await publishCodexUnifiedComputerUsePlugin(target, params.unifiedRuntime);
        } else {
          await fs.symlink(path.join(source.bundledMarketplacePath, "plugins", entry), target);
        }
      }
      await fs.writeFile(
        path.join(stagingPath, UNIFIED_SOURCE_FINGERPRINT),
        params.unifiedRuntime.sourceFingerprint,
        { mode: 0o600 },
      );
    } else {
      await fs.symlink(
        path.join(source.bundledMarketplacePath, "plugins"),
        path.join(stagingPath, "plugins"),
      );
    }
    await waitForCodexDesktopGeneration();
    assertCurrent?.();
    await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    const existing = await fs.lstat(physicalTargetPath).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing && !existing.isDirectory()) {
      throw new Error(`Managed bundled marketplace must be a real directory: ${targetPath}`);
    }
    if (existing && !(await wrapperMatchesAnySource(physicalTargetPath, ownershipCandidates))) {
      throw new Error(
        `Refusing to replace an unowned bundled marketplace directory: ${targetPath}`,
      );
    }
    if (existing) {
      assertCurrent?.();
      await fs.rename(physicalTargetPath, backupPath);
      backupCreated = true;
      await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    }
    assertCurrent?.();
    await fs.rename(stagingPath, physicalTargetPath);
    await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true });
      backupCreated = false;
    }
    return targetPath;
  } catch (error) {
    if (backupCreated) {
      try {
        await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
        const replacement = await fs.lstat(physicalTargetPath).catch(() => undefined);
        if (replacement) {
          if (!(await wrapperOwnedBySource(physicalTargetPath, source.bundledMarketplacePath))) {
            throw new Error("managed bundled marketplace replacement is no longer owned", {
              cause: error,
            });
          }
          await fs.rm(physicalTargetPath, { recursive: true });
        }
        await fs.rename(backupPath, physicalTargetPath);
        backupCreated = false;
      } catch (restoreError) {
        throw new Error(
          `Failed to restore the prior managed bundled marketplace: ${String(error)}`,
          {
            cause: restoreError,
          },
        );
      }
    }
    throw error;
  } finally {
    if (await directoryIdentityIsStable(parent)) {
      await fs.rm(stagingPath, { recursive: true, force: true });
    }
  }
}

export async function resolveCodexManagedBundledMarketplaceSource(params: {
  appServerCommand?: string;
  candidates?: readonly MacOSDesktopCodexAppPathCandidate[];
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  const candidates = params.candidates ?? resolveMacOSDesktopCodexAppPathCandidates();
  const command = params.appServerCommand && path.resolve(params.appServerCommand);
  const ordered = command
    ? candidates.filter((candidate) => path.resolve(candidate.appServerCommandPath) === command)
    : candidates;
  for (const candidate of ordered) {
    if (await isExpectedMarketplace(candidate.bundledMarketplacePath)) {
      return candidate;
    }
  }
  return undefined;
}

async function isExpectedMarketplace(root: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await fs.readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    await fs.access(path.join(root, "plugins", "computer-use", ".codex-plugin", "plugin.json"));
    return (
      isRecord(manifest) &&
      manifest.name === MARKETPLACE_NAME &&
      Array.isArray(manifest.plugins) &&
      manifest.plugins.some((plugin) => isRecord(plugin) && plugin.name === "computer-use")
    );
  } catch {
    return false;
  }
}

async function wrapperMatches(
  targetPath: string,
  sourcePath: string,
  unifiedRuntime?: CodexUnifiedComputerUseRuntime,
): Promise<boolean> {
  if (!(await wrapperOwnedBySource(targetPath, sourcePath))) {
    return false;
  }
  const plugins = await fs.lstat(path.join(targetPath, "plugins"));
  if (unifiedRuntime && plugins.isDirectory()) {
    const [sourceEntries, targetEntries] = await Promise.all([
      fs.readdir(path.join(sourcePath, "plugins")),
      fs.readdir(path.join(targetPath, "plugins")),
    ]);
    const sourceNames = new Set(sourceEntries);
    if (
      sourceNames.size !== targetEntries.length ||
      targetEntries.some((name) => !sourceNames.has(name))
    ) {
      return false;
    }
  }
  return unifiedRuntime
    ? plugins.isDirectory() &&
        (await fs
          .readFile(path.join(targetPath, UNIFIED_SOURCE_FINGERPRINT), "utf8")
          .catch(() => undefined)) === unifiedRuntime.sourceFingerprint &&
        (await codexUnifiedComputerUsePluginMatches(
          path.join(targetPath, "plugins", UNIFIED_COMPUTER_USE_PLUGIN),
          unifiedRuntime,
        ))
    : plugins.isSymbolicLink();
}

async function wrapperOwnedBySource(targetPath: string, sourcePath: string): Promise<boolean> {
  try {
    const target = await fs.lstat(targetPath);
    if (!target.isDirectory() || target.isSymbolicLink()) {
      return false;
    }
    const manifest = await fs.readlink(
      path.join(targetPath, ".agents", "plugins", "marketplace.json"),
    );
    if (manifest !== path.join(sourcePath, ".agents", "plugins", "marketplace.json")) {
      return false;
    }
    const pluginsPath = path.join(targetPath, "plugins");
    const plugins = await fs.lstat(pluginsPath);
    if (plugins.isSymbolicLink()) {
      return (await fs.readlink(pluginsPath)) === path.join(sourcePath, "plugins");
    }
    if (!plugins.isDirectory()) {
      return false;
    }
    let hasUnifiedPlugin = false;
    for (const entry of await fs.readdir(pluginsPath, { withFileTypes: true })) {
      if (entry.name === UNIFIED_COMPUTER_USE_PLUGIN && entry.isDirectory()) {
        const plugin: unknown = JSON.parse(
          await fs.readFile(
            path.join(pluginsPath, entry.name, ".codex-plugin", "plugin.json"),
            "utf8",
          ),
        );
        if (!isRecord(plugin) || plugin.name !== UNIFIED_COMPUTER_USE_PLUGIN) {
          return false;
        }
        hasUnifiedPlugin = true;
      } else if (
        !entry.isSymbolicLink() ||
        (await fs.readlink(path.join(pluginsPath, entry.name))) !==
          path.join(sourcePath, "plugins", entry.name)
      ) {
        return false;
      }
    }
    return hasUnifiedPlugin;
  } catch {
    return false;
  }
}

async function wrapperMatchesAnySource(
  targetPath: string,
  candidates: readonly MacOSDesktopCodexAppPathCandidate[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await wrapperOwnedBySource(targetPath, candidate.bundledMarketplacePath)) {
      return true;
    }
  }
  return false;
}

export async function resolveClientManagedBundledMarketplacePath(
  codexHome: string | undefined,
  agentDir: string | undefined,
): Promise<string | undefined> {
  if (!codexHome || !agentDir) {
    return undefined;
  }
  const [actualRealHome, expectedRealHome] = await Promise.all([
    fs.realpath(codexHome).catch(() => undefined),
    fs.realpath(resolveCodexAppServerHomeDir(agentDir)).catch(() => undefined),
  ]);
  if (!actualRealHome || actualRealHome !== expectedRealHome) {
    return undefined;
  }
  const managedPath = resolveCodexManagedBundledMarketplacePath(codexHome);
  return existsSync(managedPath) ? managedPath : undefined;
}
