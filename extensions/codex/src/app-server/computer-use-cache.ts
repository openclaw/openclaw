/** Shared Computer Use plugin cache reconciliation for isolated Codex homes. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertDirectoryIdentityStable,
  directoryIdentityIsStable,
  prepareOwnedServiceParent,
} from "./computer-use-service-path.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import {
  resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath,
  resolveMacOSDesktopCodexBundledMarketplaceCandidates,
} from "./desktop-app-paths.js";
import { waitForCodexDesktopGeneration } from "./desktop-generation.js";

const DEFAULT_CODEX_COMPUTER_USE_BUNDLED_MARKETPLACE_PATH =
  resolveMacOSDesktopCodexBundledMarketplaceCandidates("darwin")[0] ?? "";

const DEFAULT_BUNDLED_MARKETPLACE_NAME = "openai-bundled";
export async function ensureCodexComputerUseSharedPluginCache(params: {
  codexHome: string;
  config: ResolvedCodexComputerUseConfig;
  bundledMarketplacePath?: string;
  bundledMarketplacePathCandidates?: readonly string[];
  ownershipRoot?: string;
  assertCurrent?: () => void;
  forceRefresh?: boolean;
}): Promise<boolean> {
  if (
    !params.config.enabled ||
    params.config.pluginCacheMode === "independent" ||
    params.config.marketplaceName ||
    params.config.marketplacePath
  ) {
    return false;
  }

  const bundledMarketplacePath = resolveComputerUseBundledMarketplacePath(params);
  const sourcePluginRoot = path.join(bundledMarketplacePath, "plugins", params.config.pluginName);
  const version = await readBundledPluginVersion(sourcePluginRoot);
  if (!version) {
    return false;
  }

  const cacheRoot = path.join(
    params.codexHome,
    "plugins",
    "cache",
    params.config.marketplaceName ?? DEFAULT_BUNDLED_MARKETPLACE_NAME,
    params.config.pluginName,
  );
  const cachePath = path.join(cacheRoot, version);
  await ensureRealDirectoryCopy(cachePath, sourcePluginRoot, version, {
    codexHome: params.codexHome,
    ownershipRoot: params.ownershipRoot,
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceRefresh,
  });
  return true;
}

function resolveComputerUseBundledMarketplacePath(params: {
  bundledMarketplacePath?: string;
  bundledMarketplacePathCandidates?: readonly string[];
}): string {
  return (
    params.bundledMarketplacePath ??
    resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath({
      candidates: params.bundledMarketplacePathCandidates,
    }) ??
    params.bundledMarketplacePathCandidates?.[0] ??
    DEFAULT_CODEX_COMPUTER_USE_BUNDLED_MARKETPLACE_PATH
  );
}

async function readBundledPluginVersion(sourcePluginRoot: string): Promise<string | undefined> {
  const pluginJsonPath = path.join(sourcePluginRoot, ".codex-plugin", "plugin.json");
  try {
    const raw = await fs.readFile(pluginJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function ensureRealDirectoryCopy(
  cachePath: string,
  sourcePluginRoot: string,
  version: string,
  boundary: {
    codexHome: string;
    ownershipRoot?: string;
    assertCurrent?: () => void;
    forceRefresh?: boolean;
  },
): Promise<void> {
  const cacheRoot = path.dirname(cachePath);
  const ownedParent = boundary.ownershipRoot
    ? await prepareOwnedServiceParent({
        ownershipRoot: boundary.ownershipRoot,
        codexHome: boundary.codexHome,
        targetParent: cacheRoot,
      })
    : undefined;
  if (!ownedParent) {
    await fs.mkdir(cacheRoot, { recursive: true });
  }
  const physicalCachePath = ownedParent
    ? path.join(ownedParent.realPath, path.basename(cachePath))
    : cachePath;
  const stat = await fs.lstat(physicalCachePath).catch(() => undefined);
  if (stat?.isDirectory() && !stat.isSymbolicLink()) {
    const cachedVersion = await readBundledPluginVersion(physicalCachePath);
    if (cachedVersion === version && !boundary.forceRefresh) {
      return;
    }
  }
  const cacheName = path.basename(cachePath);
  const physicalCacheRoot = path.dirname(physicalCachePath);
  const stagingRoot = await fs.mkdtemp(path.join(physicalCacheRoot, `.${cacheName}.staging-`));
  const stagedPath = path.join(stagingRoot, cacheName);
  const backupPath = path.join(
    physicalCacheRoot,
    `.${cacheName}.backup-${process.pid}-${Date.now()}`,
  );
  let backupCreated = false;
  try {
    await fs.cp(sourcePluginRoot, stagedPath, { recursive: true });
    // Source-copy notifications are only invalidations; reconcile them before
    // the original generation's synchronous guard authorizes publication.
    await waitForCodexDesktopGeneration();
    if (ownedParent) {
      await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
    }
    if (stat) {
      boundary.assertCurrent?.();
      await fs.rename(physicalCachePath, backupPath);
      backupCreated = true;
    }
    try {
      if (ownedParent) {
        await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
      }
      boundary.assertCurrent?.();
      await fs.rename(stagedPath, physicalCachePath);
    } catch (error) {
      if (backupCreated) {
        try {
          if (ownedParent) {
            await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
          }
          await fs.rename(backupPath, physicalCachePath);
          backupCreated = false;
        } catch (restoreError) {
          throw new Error(
            `Failed to install Computer Use cache ${cachePath} and restore its prior copy: ${String(error)}`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    if (backupCreated) {
      if (ownedParent) {
        await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
      }
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  } finally {
    if (!ownedParent || (await directoryIdentityIsStable(ownedParent))) {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }
}
