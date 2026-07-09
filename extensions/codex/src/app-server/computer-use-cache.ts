/** Shared Computer Use plugin cache reconciliation for isolated Codex homes. */
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

export type CodexComputerUsePluginCacheRepairResult =
  | {
      status: "disabled" | "explicit_marketplace" | "independent" | "source_missing" | "shared";
      changed: boolean;
      message: string;
      cachePath?: string;
      targetPath?: string;
      version?: string;
      removedStaleVersions: string[];
      warnings: string[];
    }
  | {
      status: "failed";
      changed: false;
      message: string;
      removedStaleVersions: string[];
      warnings: string[];
    };

export const DEFAULT_CODEX_COMPUTER_USE_BUNDLED_MARKETPLACE_PATH =
  "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled";

const DEFAULT_BUNDLED_MARKETPLACE_NAME = "openai-bundled";

export async function ensureCodexComputerUseSharedPluginCache(params: {
  codexHome: string;
  config: ResolvedCodexComputerUseConfig;
  bundledMarketplacePath?: string;
}): Promise<CodexComputerUsePluginCacheRepairResult> {
  if (!params.config.enabled) {
    return skippedCacheResult(
      "disabled",
      "Computer Use cache sharing skipped because it is disabled.",
    );
  }
  if (params.config.pluginCacheMode === "independent") {
    return skippedCacheResult(
      "independent",
      "Computer Use cache sharing skipped because pluginCacheMode is independent.",
    );
  }
  if (params.config.marketplaceName || params.config.marketplacePath) {
    return skippedCacheResult(
      "explicit_marketplace",
      "Computer Use cache sharing skipped because an explicit marketplace is configured.",
    );
  }

  const bundledMarketplacePath =
    params.bundledMarketplacePath ?? DEFAULT_CODEX_COMPUTER_USE_BUNDLED_MARKETPLACE_PATH;
  const sourcePluginRoot = path.join(bundledMarketplacePath, "plugins", params.config.pluginName);
  const version = await readBundledPluginVersion(sourcePluginRoot);
  if (!version) {
    return skippedCacheResult(
      "source_missing",
      `Computer Use bundled plugin source was not found at ${sourcePluginRoot}.`,
    );
  }

  const marketplaceName = params.config.marketplaceName ?? DEFAULT_BUNDLED_MARKETPLACE_NAME;
  const cacheRoot = path.join(
    params.codexHome,
    "plugins",
    "cache",
    marketplaceName,
    params.config.pluginName,
  );
  const cachePath = path.join(cacheRoot, version);
  const removedStaleVersions = await removeStalePluginCacheVersions(cacheRoot, version);
  const changed = await ensureRealDirectoryCopy(cachePath, sourcePluginRoot, version);
  return {
    status: "shared",
    changed: changed || removedStaleVersions.length > 0,
    cachePath,
    targetPath: sourcePluginRoot,
    version,
    removedStaleVersions,
    warnings: [],
    message: `Computer Use plugin cache ${cachePath} contains bundled plugin ${sourcePluginRoot}.`,
  };
}

async function readBundledPluginVersion(sourcePluginRoot: string): Promise<string | undefined> {
  const pluginJsonPath = path.join(sourcePluginRoot, ".codex-plugin", "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(pluginJsonPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function removeStalePluginCacheVersions(
  cacheRoot: string,
  activeVersion: string,
): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.name === activeVersion) {
      continue;
    }
    await fs.rm(path.join(cacheRoot, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.toSorted();
}

async function ensureRealDirectoryCopy(
  cachePath: string,
  sourcePluginRoot: string,
  version: string,
): Promise<boolean> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const stat = await fs.lstat(cachePath).catch(() => undefined);
  if (stat?.isDirectory() && !stat.isSymbolicLink()) {
    const cachedVersion = await readBundledPluginVersion(cachePath);
    if (cachedVersion === version) {
      return false;
    }
  }
  await fs.rm(cachePath, { recursive: true, force: true });
  await fs.cp(sourcePluginRoot, cachePath, { recursive: true });
  return true;
}

function skippedCacheResult(
  status: "disabled" | "explicit_marketplace" | "independent" | "source_missing",
  message: string,
): CodexComputerUsePluginCacheRepairResult {
  return {
    status,
    changed: false,
    message,
    removedStaleVersions: [],
    warnings: status === "source_missing" ? [message] : [],
  };
}
