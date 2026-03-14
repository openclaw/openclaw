/**
 * Plugin Discovery — 扫描目录，发现插件候选项
 *
 * 对应 openclaw: src/plugins/discovery.ts
 *
 * 职责（与原版一致）：
 *   只负责找到插件入口文件路径，返回 PluginCandidate[]
 *   不加载模块，不调用 register，不操作 registry
 *
 * 调用方：loader.ts 的 loadOpenClawPlugins()
 *
 * 扫描路径优先级（与原版 discovery.ts:618 对齐）：
 *   1. extraPaths          → origin: "config"   （配置文件指定路径）
 *   2. workspaceDir/.openclaw/extensions → origin: "workspace"
 *   3. bundledDir          → origin: "bundled"  （demo 无内置插件，跳过）
 *   4. ~/.openclaw/extensions → origin: "global" （全局安装插件）
 *
 * 简化说明（相比 openclaw 原版省略的部分）：
 *   - 发现缓存（discoveryCache）
 *   - 路径安全检查（openBoundaryFileSync / rejectHardlinks / ownershipUid）
 *   - bundled 插件目录扫描（resolveBundledPluginsDir）
 *   - shouldIgnoreScannedDirectory（.bak / .disabled 等）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginDiagnostic, PluginManifest, PluginOrigin } from "../types.js";

// ─── 常量（对应 openclaw manifest.ts:155）─────────────────────────────────

/**
 * openclaw: DEFAULT_PLUGIN_ENTRY_CANDIDATES (manifest.ts:155)
 * 按优先级顺序查找插件入口文件
 */
export const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
  "index.ts",
  "index.js",
  "index.mjs",
  "index.cjs",
] as const;

// ─── 类型（对应 openclaw discovery.ts:18-34）──────────────────────────────

/**
 * openclaw: PluginCandidate (discovery.ts:18)
 * 一个待加载的插件候选项，由 discoverOpenClawPlugins 返回，由 loader 消费
 *
 * 简化字段说明（相比原版省略）：
 *   - packageName / packageVersion / packageDescription / packageDir / packageManifest：
 *     原版用于 npm 包插件；demo 工程只扫描本地目录
 */
export type PluginCandidate = {
  /** 插件 id（来自 openclaw.plugin.json 或目录名） */
  idHint: string;
  /** 入口文件绝对路径（index.ts 等） */
  source: string;
  /** 插件根目录 */
  rootDir: string;
  /**
   * openclaw: PluginCandidate.origin (discovery.ts:22)
   * "config" = extraPaths 指定；"workspace" = 工作区本地；
   * "global" = ~/.openclaw/extensions；"bundled" = 内置
   */
  origin: PluginOrigin;
  /** 插件清单（从 openclaw.plugin.json 解析，若存在） */
  manifest: PluginManifest;
};

/**
 * openclaw: PluginDiscoveryResult (discovery.ts:31)
 */
export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  /** openclaw: PluginDiagnostic[] (types.ts) */
  diagnostics: PluginDiagnostic[];
};

// ─── 路径解析（对应 openclaw utils.ts:resolveConfigDir）────────────────────

/**
 * 解析 openclaw 全局配置目录
 * openclaw: resolveConfigDir() (utils.ts:304)
 *   → 默认 ~/.openclaw；可通过 OPENCLAW_STATE_DIR 覆盖
 */
function resolveConfigDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override.replace(/^~/, os.homedir()));
  }
  return path.join(os.homedir(), ".openclaw");
}

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

/** 读取 openclaw.plugin.json（对应 discovery.ts 中的 readPackageManifest） */
function readPluginManifest(dir: string): PluginManifest | null {
  const manifestPath = path.join(dir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {return null;}
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifest;
  } catch {
    return null;
  }
}

/**
 * 读取 package.json 中的 openclaw.extensions[] 字段
 * 对应 openclaw manifest.ts:184 resolvePackageExtensionEntries()
 *
 * dingtalk-connector 等插件入口不叫 index.ts，而是在 package.json 中声明：
 *   { "openclaw": { "extensions": ["./plugin.ts"] } }
 * 原版优先级：openclaw.extensions[] > DEFAULT_PLUGIN_ENTRY_CANDIDATES
 */
function resolvePackageExtensionEntries(pluginDir: string): string[] {
  const pkgPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(pkgPath)) {return [];}
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      openclaw?: { extensions?: unknown };
    };
    const raw = pkg.openclaw?.extensions;
    if (!Array.isArray(raw)) {return [];}
    return (raw as unknown[])
      .map((e) => (typeof e === "string" ? e.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 在目录中按 DEFAULT_PLUGIN_ENTRY_CANDIDATES 顺序查找入口文件 */
function findEntryFile(dir: string): string | null {
  for (const candidate of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) {return full;}
  }
  return null;
}

// ─── 主要导出 ──────────────────────────────────────────────────────────────

/**
 * 扫描单个目录，将发现的插件加入 candidates
 * openclaw: discoverInDirectory() (discovery.ts:394，demo 额外导出供外部使用)
 *
 * 入口文件解析优先级（与原版 discovery.ts:444-498 对齐）：
 *   1. package.json 的 openclaw.extensions[]（resolvePackageExtensionEntries）
 *      → 如 dingtalk-connector 用 "./plugin.ts" 而非 index.ts
 *   2. DEFAULT_PLUGIN_ENTRY_CANDIDATES fallback（index.ts / index.js / ...）
 */
export function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
}): void {
  const { dir, origin, candidates, diagnostics } = params;

  if (!fs.existsSync(dir)) {
    // 全局/工作区目录不存在是正常情况，静默跳过（对应原版也不 push error）
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${dir} (${String(err)})`,
      source: dir,
    });
    return;
  }

  for (const entry of entries.filter((e) => e.isDirectory())) {
    const pluginDir = path.join(dir, entry.name);

    const manifest = readPluginManifest(pluginDir);
    if (!manifest?.id) {
      // 没有 openclaw.plugin.json 的目录静默跳过（node_modules 等）
      continue;
    }

    // 优先级 1：package.json 的 openclaw.extensions[]（discovery.ts:444-479）
    // 对应原版 resolvePackageExtensionEntries + addCandidate 循环
    const pkgExtensions = resolvePackageExtensionEntries(pluginDir);
    if (pkgExtensions.length > 0) {
      for (const extPath of pkgExtensions) {
        const source = path.resolve(pluginDir, extPath);
        if (!fs.existsSync(source)) {
          diagnostics.push({
            level: "warn",
            message: `plugin "${entry.name}": package.json openclaw.extensions entry not found: ${extPath}`,
            source: pluginDir,
          });
          continue;
        }
        candidates.push({ idHint: manifest.id, source, rootDir: pluginDir, origin, manifest });
      }
      continue; // 找到 package.json 声明的入口后不再 fallback
    }

    // 优先级 2：DEFAULT_PLUGIN_ENTRY_CANDIDATES fallback（discovery.ts:481-498）
    const source = findEntryFile(pluginDir);
    if (!source) {
      diagnostics.push({
        level: "warn",
        message: `no entry file in "${entry.name}" (tried package.json openclaw.extensions and: ${DEFAULT_PLUGIN_ENTRY_CANDIDATES.join(", ")}), skipping`,
        source: pluginDir,
      });
      continue;
    }

    candidates.push({ idHint: manifest.id, source, rootDir: pluginDir, origin, manifest });
  }
}

/**
 * 扫描所有插件来源，返回候选项列表（不加载模块）
 * openclaw: discoverOpenClawPlugins() (discovery.ts:618)
 *
 * 扫描顺序（与原版一致）：
 *   1. extraPaths（origin: "config"）
 *   2. workspaceDir/.openclaw/extensions（origin: "workspace"）
 *   3. bundledDir（demo 跳过，无内置插件）
 *   4. ~/.openclaw/extensions（origin: "global"）
 *
 * @param pluginsDir   demo 本地插件目录，作为 "config" 来源扫描
 * @param workspaceDir 工作区根目录（可选，openclaw: params.workspaceDir）
 * @param extraPaths   额外扫描路径（可选，openclaw: params.extraPaths）
 */
export function discoverOpenClawPlugins(params: {
  pluginsDir?: string;
  workspaceDir?: string;
  extraPaths?: string[];
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  // 1. extraPaths（对应 discovery.ts:644-662，origin: "config"）
  const extraPaths = [
    ...(params.pluginsDir ? [params.pluginsDir] : []),
    ...(params.extraPaths ?? []),
  ];
  for (const extraPath of extraPaths) {
    const trimmed = extraPath.trim();
    if (!trimmed) {continue;}
    const resolved = path.resolve(trimmed.replace(/^~/, os.homedir()));
    discoverInDirectory({ dir: resolved, origin: "config", candidates, diagnostics });
  }

  // 2. workspaceDir/.openclaw/extensions（对应 discovery.ts:663-677，origin: "workspace"）
  if (params.workspaceDir) {
    const workspaceExtDir = path.join(
      path.resolve(params.workspaceDir.replace(/^~/, os.homedir())),
      ".openclaw",
      "extensions",
    );
    discoverInDirectory({ dir: workspaceExtDir, origin: "workspace", candidates, diagnostics });
  }

  // 3. bundledDir — demo 工程无内置插件，跳过（对应 discovery.ts:679-689）

  // 4. ~/.openclaw/extensions（对应 discovery.ts:693-701，origin: "global"）
  const globalDir = path.join(resolveConfigDir(), "extensions");
  discoverInDirectory({ dir: globalDir, origin: "global", candidates, diagnostics });

  return { candidates, diagnostics };
}
