/** Shared Computer Use plugin cache reconciliation for isolated Codex homes. */
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
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

  const bundledMarketplacePath =
    params.bundledMarketplacePath ??
    resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath({
      candidates: params.bundledMarketplacePathCandidates,
    }) ??
    params.bundledMarketplacePathCandidates?.[0] ??
    DEFAULT_CODEX_COMPUTER_USE_BUNDLED_MARKETPLACE_PATH;
  const sourcePluginRoot = path.join(bundledMarketplacePath, "plugins", params.config.pluginName);
  const version = await readBundledPluginVersion(sourcePluginRoot);
  if (!version) {
    return false;
  }

  const cachePath = path.join(
    params.codexHome,
    "plugins",
    "cache",
    params.config.marketplaceName ?? DEFAULT_BUNDLED_MARKETPLACE_NAME,
    params.config.pluginName,
    version,
  );
  const cacheRoot = path.dirname(cachePath);
  const ownedParent = params.ownershipRoot
    ? await prepareOwnedServiceParent({
        ownershipRoot: params.ownershipRoot,
        codexHome: params.codexHome,
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
    if (cachedVersion === version && !params.forceRefresh) {
      // Generated launcher paths can change without a plugin version bump.
      const [cachedMcp, sourceMcp] = await Promise.all(
        [physicalCachePath, sourcePluginRoot].map(async (root) =>
          fs.readFile(path.join(root, ".mcp.json"), "utf8").catch((error: unknown) => {
            if (extractErrorCode(error) === "ENOENT") {
              return undefined;
            }
            throw error;
          }),
        ),
      );
      if (cachedMcp === sourceMcp) {
        return true;
      }
    }
  }
  const cacheName = path.basename(cachePath);
  const physicalCacheRoot = path.dirname(physicalCachePath);
  const stagingRoot = await fs.mkdtemp(path.join(physicalCacheRoot, `.${cacheName}.staging-`));
  const stagedPath = path.join(stagingRoot, cacheName);
  try {
    // The managed marketplace links to desktop plugins; native discovery needs a
    // real version directory. Resolve only the root, preserving nested symlinks.
    const physicalSourceRoot = await fs.realpath(sourcePluginRoot);
    await fs.cp(physicalSourceRoot, stagedPath, { recursive: true });
    if (ownedParent) {
      await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
    }
    if (stat) {
      params.assertCurrent?.();
      // This is a generated cache, not user data. A failed swap is repaired by
      // the next startup instead of retaining a backup/rollback protocol.
      await fs.rm(physicalCachePath, { recursive: true, force: true });
      if (ownedParent) {
        await assertDirectoryIdentityStable(ownedParent, "Computer Use plugin cache parent");
      }
    }
    params.assertCurrent?.();
    await fs.rename(stagedPath, physicalCachePath);
  } finally {
    if (!ownedParent || (await directoryIdentityIsStable(ownedParent))) {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }
  return true;
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
