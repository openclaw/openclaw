import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveCodexAppServerRuntimeOptions } from "../app-server/config.js";
import type { v2 } from "../app-server/protocol-generated/typescript/index.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import {
  exists,
  isDirectory,
  readJsonObject,
  resolveHomePath,
  resolveUserHomeDir,
} from "./helpers.js";

const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2000;
const OPENAI_CURATED_MARKETPLACE = "openai-curated";
const CODEX_PLUGIN_DISCOVERY_TIMEOUT_MS = 5_000;

export type CodexSkillSource = {
  name: string;
  source: string;
  sourceLabel: string;
};

export type CodexPluginSource = {
  name: string;
  source: string;
  manifestPath: string;
};

export type CodexInstalledPluginSource = {
  id: string;
  name: string;
  displayName: string;
  marketplaceName: typeof OPENAI_CURATED_MARKETPLACE;
  marketplacePath?: string;
  installed: boolean;
  enabled: boolean;
  accessible?: boolean;
};

type CodexArchiveSource = {
  id: string;
  path: string;
  relativePath: string;
  message?: string;
};

type CodexSource = {
  root: string;
  confidence: "low" | "medium" | "high";
  codexHome: string;
  codexSkillsDir?: string;
  personalAgentsSkillsDir?: string;
  configPath?: string;
  hooksPath?: string;
  skills: CodexSkillSource[];
  nativePlugins: CodexInstalledPluginSource[];
  pluginDiscoveryError?: string;
  plugins: CodexPluginSource[];
  archivePaths: CodexArchiveSource[];
};

type CodexMigrationAppServerRequest = (method: string, params?: unknown) => Promise<unknown>;

let appServerRequestForTests: CodexMigrationAppServerRequest | undefined;

function defaultCodexHome(): string {
  return resolveHomePath(process.env.CODEX_HOME?.trim() || "~/.codex");
}

function personalAgentsSkillsDir(): string {
  return path.join(resolveUserHomeDir(), ".agents", "skills");
}

async function safeReadDir(dir: string): Promise<Dirent[]> {
  return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function discoverSkillDirs(params: {
  root: string | undefined;
  sourceLabel: string;
  excludeSystem?: boolean;
}): Promise<CodexSkillSource[]> {
  if (!params.root || !(await isDirectory(params.root))) {
    return [];
  }
  const discovered: CodexSkillSource[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const name = path.basename(dir);
    if (params.excludeSystem && depth === 1 && name === ".system") {
      return;
    }
    if (await exists(path.join(dir, SKILL_FILENAME))) {
      discovered.push({ name, source: dir, sourceLabel: params.sourceLabel });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(params.root, 0);
  return discovered;
}

async function discoverPluginDirs(codexHome: string): Promise<CodexPluginSource[]> {
  const root = path.join(codexHome, "plugins", "cache");
  if (!(await isDirectory(root))) {
    return [];
  }
  const discovered = new Map<string, CodexPluginSource>();
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
    if (await exists(manifestPath)) {
      const manifest = await readJsonObject(manifestPath);
      const manifestName = typeof manifest.name === "string" ? manifest.name.trim() : "";
      const name = manifestName || path.basename(dir);
      discovered.set(dir, { name, source: dir, manifestPath });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return [...discovered.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}

function displayNameForPlugin(plugin: v2.PluginSummary): string {
  const displayName = plugin.interface?.displayName?.trim();
  return displayName || plugin.name || plugin.id;
}

function pluginNameFromSummary(plugin: v2.PluginSummary): string {
  const name = plugin.name.trim();
  if (name) {
    return name;
  }
  return plugin.id.replace(new RegExp(`@${OPENAI_CURATED_MARKETPLACE}$`, "u"), "");
}

function pluginAccessible(
  plugin: v2.PluginSummary,
  apps: readonly v2.AppInfo[],
): boolean | undefined {
  const displayName = displayNameForPlugin(plugin).toLowerCase();
  const pluginName = pluginNameFromSummary(plugin).toLowerCase();
  const matchingApps = apps.filter((app) => {
    const pluginNames = new Set(
      app.pluginDisplayNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );
    return pluginNames.has(displayName) || pluginNames.has(pluginName);
  });
  if (matchingApps.length === 0) {
    return undefined;
  }
  return matchingApps.every((app) => app.isAccessible && app.isEnabled);
}

function readCodexPluginConfigFromOpenClawConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const plugins = (config as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return undefined;
  }
  const entries = (plugins as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return undefined;
  }
  const codex = (entries as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) {
    return undefined;
  }
  return (codex as { config?: unknown }).config;
}

async function defaultAppServerRequest(params: {
  codexHome: string;
  pluginConfig?: unknown;
  config?: OpenClawConfig;
}): Promise<CodexMigrationAppServerRequest> {
  const runtimeOptions = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const startOptions = {
    ...runtimeOptions.start,
    env: {
      ...runtimeOptions.start.env,
      CODEX_HOME: params.codexHome,
    },
  };
  return async (method: string, requestParams?: unknown): Promise<unknown> =>
    await requestCodexAppServerJson({
      method,
      requestParams,
      timeoutMs: CODEX_PLUGIN_DISCOVERY_TIMEOUT_MS,
      startOptions,
      config: params.config,
    });
}

async function listAllApps(request: CodexMigrationAppServerRequest): Promise<v2.AppInfo[]> {
  const apps: v2.AppInfo[] = [];
  let cursor: string | null | undefined;
  do {
    const params = {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 100,
      forceRefetch: true,
    } satisfies v2.AppsListParams;
    const response = (await request("app/list", params)) as v2.AppsListResponse;
    apps.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return apps;
}

async function discoverInstalledOpenAiCuratedPlugins(params: {
  codexHome: string;
  pluginConfig?: unknown;
  config?: OpenClawConfig;
  appServerRequest?: CodexMigrationAppServerRequest;
}): Promise<{ plugins: CodexInstalledPluginSource[]; error?: string }> {
  try {
    const request =
      params.appServerRequest ??
      appServerRequestForTests ??
      (await defaultAppServerRequest({
        codexHome: params.codexHome,
        pluginConfig: params.pluginConfig,
        config: params.config,
      }));
    const [listed, apps] = await Promise.all([
      request("plugin/list", {
        cwds: [],
      } satisfies v2.PluginListParams) as Promise<v2.PluginListResponse>,
      listAllApps(request),
    ]);
    const marketplace = listed.marketplaces.find(
      (entry) => entry.name === OPENAI_CURATED_MARKETPLACE,
    );
    if (!marketplace) {
      return { plugins: [] };
    }
    const plugins = marketplace.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin): CodexInstalledPluginSource => {
        const accessible = pluginAccessible(plugin, apps);
        const source: CodexInstalledPluginSource = {
          id: plugin.id,
          name: pluginNameFromSummary(plugin),
          displayName: displayNameForPlugin(plugin),
          marketplaceName: OPENAI_CURATED_MARKETPLACE,
          installed: plugin.installed,
          enabled: plugin.enabled,
        };
        if (marketplace.path) {
          source.marketplacePath = marketplace.path;
        }
        if (accessible !== undefined) {
          source.accessible = accessible;
        }
        return source;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return { plugins };
  } catch (err) {
    return { plugins: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function discoverCodexSource(
  input?: string,
  options: {
    config?: OpenClawConfig;
    appServerRequest?: CodexMigrationAppServerRequest;
  } = {},
): Promise<CodexSource> {
  const codexHome = resolveHomePath(input?.trim() || defaultCodexHome());
  const codexSkillsDir = path.join(codexHome, "skills");
  const agentsSkillsDir = personalAgentsSkillsDir();
  const configPath = path.join(codexHome, "config.toml");
  const hooksPath = path.join(codexHome, "hooks", "hooks.json");
  const codexSkills = await discoverSkillDirs({
    root: codexSkillsDir,
    sourceLabel: "Codex CLI skill",
    excludeSystem: true,
  });
  const personalAgentSkills = await discoverSkillDirs({
    root: agentsSkillsDir,
    sourceLabel: "personal AgentSkill",
  });
  const appServerPlugins = await discoverInstalledOpenAiCuratedPlugins({
    codexHome,
    pluginConfig: readCodexPluginConfigFromOpenClawConfig(options.config),
    config: options.config,
    appServerRequest: options.appServerRequest,
  });
  const plugins = await discoverPluginDirs(codexHome);
  const archivePaths: CodexArchiveSource[] = [];
  if (await exists(configPath)) {
    archivePaths.push({
      id: "archive:config.toml",
      path: configPath,
      relativePath: "config.toml",
      message: "Codex config is archived for manual review; it is not activated automatically.",
    });
  }
  if (await exists(hooksPath)) {
    archivePaths.push({
      id: "archive:hooks/hooks.json",
      path: hooksPath,
      relativePath: "hooks/hooks.json",
      message:
        "Codex native hooks are archived for manual review because they can execute commands.",
    });
  }
  const skills = [...codexSkills, ...personalAgentSkills].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
  const high = Boolean(
    codexSkills.length || appServerPlugins.plugins.length || plugins.length || archivePaths.length,
  );
  const medium = personalAgentSkills.length > 0;
  return {
    root: codexHome,
    confidence: high ? "high" : medium ? "medium" : "low",
    codexHome,
    ...((await isDirectory(codexSkillsDir)) ? { codexSkillsDir } : {}),
    ...((await isDirectory(agentsSkillsDir)) ? { personalAgentsSkillsDir: agentsSkillsDir } : {}),
    ...((await exists(configPath)) ? { configPath } : {}),
    ...((await exists(hooksPath)) ? { hooksPath } : {}),
    skills,
    nativePlugins: appServerPlugins.plugins,
    ...(appServerPlugins.error ? { pluginDiscoveryError: appServerPlugins.error } : {}),
    plugins,
    archivePaths,
  };
}

export function hasCodexSource(source: CodexSource): boolean {
  return source.confidence !== "low";
}

export const __testing = {
  setAppServerRequestForTests(request: CodexMigrationAppServerRequest | undefined): void {
    appServerRequestForTests = request;
  },
};
