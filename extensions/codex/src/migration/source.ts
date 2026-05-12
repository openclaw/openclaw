import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultCodexAppInventoryCache,
  type CodexAppInventoryRequest,
} from "../app-server/app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import type { CodexAppServerStartOptions } from "../app-server/config.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import {
  pluginReadParams,
  type CodexPluginMarketplaceRef,
} from "../app-server/plugin-inventory.js";
import type { v2 } from "../app-server/protocol.js";
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

export type CodexSkillSource = {
  name: string;
  source: string;
  sourceLabel: string;
};

export type CodexPluginSource = {
  name: string;
  source: string;
  sourceKind: "app-server" | "cache";
  migratable: boolean;
  manifestPath?: string;
  marketplaceName?: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
  pluginName?: string;
  installed?: boolean;
  enabled?: boolean;
  appReadiness?: CodexPluginAppReadiness;
  message?: string;
};

export type CodexPluginAppReadinessStatus =
  | "not_app_backed"
  | "ready"
  | "inaccessible"
  | "missing"
  | "disabled"
  | "plugin_disabled"
  | "auth_required"
  | "unknown";

export type CodexPluginAppReadinessCode =
  | "plugin_disabled"
  | "app_inaccessible"
  | "app_disabled"
  | "app_missing"
  | "app_auth_required"
  | "app_readiness_unknown"
  | "plugin_read_unavailable"
  | "app_inventory_unavailable";

export type CodexPluginAppReadinessAppStatus =
  | "ready"
  | "inaccessible"
  | "missing"
  | "disabled"
  | "auth_required"
  | "unknown";

export type CodexPluginAppReadinessApp = {
  id: string;
  name: string;
  status: CodexPluginAppReadinessAppStatus;
  isAccessible?: boolean;
  isEnabled?: boolean;
  needsAuth?: boolean;
};

export type CodexPluginAppReadiness = {
  status: CodexPluginAppReadinessStatus;
  reason?: CodexPluginAppReadinessCode;
  apps: CodexPluginAppReadinessApp[];
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
  plugins: CodexPluginSource[];
  pluginDiscoveryError?: string;
  archivePaths: CodexArchiveSource[];
};

type CodexSourceDiscoveryOptions = {
  input?: string;
  evaluatePluginAppReadiness?: boolean;
};

type SourceAppServerRequestOptions = {
  startOptions: CodexAppServerStartOptions;
};

type PluginReadResult =
  | {
      ok: true;
      detail: v2.PluginDetail;
    }
  | {
      ok: false;
      error: string;
    };

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
      discovered.set(dir, {
        name,
        source: dir,
        manifestPath,
        sourceKind: "cache",
        migratable: false,
        message:
          "Cached Codex plugin bundle found. Review manually unless the plugin is also installed in the source Codex app-server inventory.",
      });
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

async function discoverInstalledCuratedPlugins(
  codexHome: string,
  options: CodexSourceDiscoveryOptions = {},
): Promise<{
  plugins: CodexPluginSource[];
  error?: string;
}> {
  const startOptions = sourceCodexAppServerStartOptions(codexHome);
  const requestOptions = { startOptions };
  try {
    const response = await requestSourceCodexAppServerJson<v2.PluginListResponse>(requestOptions, {
      method: "plugin/list",
      requestParams: { cwds: [] } satisfies v2.PluginListParams,
    });
    const marketplace = response.marketplaces.find(
      (entry) => entry.name === CODEX_PLUGINS_MARKETPLACE_NAME,
    );
    if (!marketplace) {
      return {
        plugins: [],
        error: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found in source plugin inventory.`,
      };
    }
    const plugins = marketplace.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin) => buildInstalledPluginSource(plugin))
      .filter((plugin): plugin is CodexPluginSource => plugin !== undefined);
    const withReadiness =
      options.evaluatePluginAppReadiness === true
        ? await withPluginAppReadiness({
            plugins,
            marketplace: marketplaceRef(marketplace),
            requestOptions,
          })
        : plugins;
    const sorted = withReadiness.toSorted((a, b) =>
      (a.pluginName ?? a.name).localeCompare(b.pluginName ?? b.name),
    );
    return { plugins: sorted };
  } catch (error) {
    return {
      plugins: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceCodexAppServerStartOptions(codexHome: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "config",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
    env: {
      CODEX_HOME: codexHome,
      HOME: path.dirname(codexHome),
    },
  };
}

async function requestSourceCodexAppServerJson<T>(
  options: SourceAppServerRequestOptions,
  params: {
    method: string;
    requestParams?: unknown;
  },
): Promise<T> {
  return await requestCodexAppServerJson<T>({
    method: params.method,
    requestParams: params.requestParams,
    timeoutMs: 60_000,
    startOptions: options.startOptions,
    authProfileId: null,
  });
}

function buildInstalledPluginSource(plugin: v2.PluginSummary): CodexPluginSource | undefined {
  const pluginName = pluginNameFromSummary(plugin);
  if (!pluginName) {
    return undefined;
  }
  return {
    name: plugin.name,
    pluginName,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    source: `${CODEX_PLUGINS_MARKETPLACE_NAME}/${pluginName}`,
    sourceKind: "app-server",
    migratable: true,
    installed: plugin.installed,
    enabled: plugin.enabled,
  };
}

function marketplaceRef(marketplace: v2.PluginMarketplaceEntry): CodexPluginMarketplaceRef {
  return {
    name: CODEX_PLUGINS_MARKETPLACE_NAME,
    ...(marketplace.path ? { path: marketplace.path } : {}),
    ...(!marketplace.path ? { remoteMarketplaceName: marketplace.name } : {}),
  };
}

async function withPluginAppReadiness(params: {
  plugins: CodexPluginSource[];
  marketplace: CodexPluginMarketplaceRef;
  requestOptions: SourceAppServerRequestOptions;
}): Promise<CodexPluginSource[]> {
  const pending: Array<{ plugin: CodexPluginSource; detail: v2.PluginDetail }> = [];
  const evaluated: CodexPluginSource[] = [];

  for (const plugin of params.plugins) {
    if (plugin.enabled !== true) {
      evaluated.push({
        ...plugin,
        migratable: false,
        appReadiness: {
          status: "plugin_disabled",
          reason: "plugin_disabled",
          apps: [],
        },
        message: `Codex plugin "${plugin.pluginName ?? plugin.name}" is installed in Codex but disabled; enable it in Codex before migrating it to OpenClaw.`,
      });
      continue;
    }

    const detail = await readPluginDetail(params.requestOptions, params.marketplace, plugin);
    if (!detail.ok) {
      evaluated.push({
        ...plugin,
        migratable: false,
        appReadiness: {
          status: "unknown",
          reason: "plugin_read_unavailable",
          apps: [],
        },
        message: `Codex plugin "${plugin.pluginName ?? plugin.name}" detail could not be read: ${detail.error}`,
      });
      continue;
    }

    if (detail.detail.apps.length === 0) {
      evaluated.push({
        ...plugin,
        migratable: true,
        appReadiness: {
          status: "not_app_backed",
          apps: [],
        },
      });
      continue;
    }

    const appBackedPlugin: CodexPluginSource = {
      ...plugin,
      migratable: false,
      appReadiness: {
        status: "unknown",
        reason: "app_readiness_unknown",
        apps: detail.detail.apps.map((app) => ({
          id: app.id,
          name: app.name,
          status: "unknown" as const,
          needsAuth: app.needsAuth,
        })),
      },
    };
    evaluated.push(appBackedPlugin);
    pending.push({ plugin: appBackedPlugin, detail: detail.detail });
  }

  if (pending.length === 0) {
    return evaluated;
  }

  const snapshot = await refreshSourceAppInventory(params.requestOptions).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    for (const { plugin } of pending) {
      plugin.appReadiness = {
        status: "unknown",
        reason: "app_inventory_unavailable",
        apps:
          plugin.appReadiness?.apps.map((app) => ({
            ...app,
            status: "unknown",
          })) ?? [],
      };
      plugin.message = `Codex plugin "${plugin.pluginName ?? plugin.name}" owns apps, but source app inventory could not be read: ${message}`;
    }
    return undefined;
  });
  if (!snapshot) {
    return evaluated;
  }

  const appInfoById = new Map(snapshot.apps.map((app) => [app.id, app] as const));
  for (const { plugin, detail } of pending) {
    const apps = detail.apps
      .map((app) => sourceAppReadiness(app, appInfoById.get(app.id)))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const status = summarizeAppReadiness(apps);
    const ready = status === "ready";
    plugin.migratable = ready;
    plugin.appReadiness = {
      status,
      ...(ready ? {} : { reason: readinessCode(status) }),
      apps,
    };
    if (!ready) {
      plugin.message = appReadinessMessage(plugin, apps, status);
    }
  }

  return evaluated;
}

async function readPluginDetail(
  options: SourceAppServerRequestOptions,
  marketplace: CodexPluginMarketplaceRef,
  plugin: CodexPluginSource,
): Promise<PluginReadResult> {
  try {
    const response = await requestSourceCodexAppServerJson<v2.PluginReadResponse>(options, {
      method: "plugin/read",
      requestParams: pluginReadParams(marketplace, plugin.pluginName ?? plugin.name),
    });
    return { ok: true, detail: response.plugin };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function refreshSourceAppInventory(
  options: SourceAppServerRequestOptions,
): Promise<Awaited<ReturnType<typeof defaultCodexAppInventoryCache.refreshNow>>> {
  const key = buildCodexPluginAppCacheKey({
    appServer: { start: options.startOptions },
  });
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    await requestSourceCodexAppServerJson<v2.AppsListResponse>(options, {
      method,
      requestParams,
    });
  return await defaultCodexAppInventoryCache.refreshNow({
    key,
    request,
    forceRefetch: true,
  });
}

function sourceAppReadiness(
  app: v2.AppSummary,
  info: v2.AppInfo | undefined,
): CodexPluginAppReadinessApp {
  if (!info) {
    return {
      id: app.id,
      name: app.name,
      status: "missing",
      needsAuth: app.needsAuth,
    };
  }
  const status: CodexPluginAppReadinessAppStatus = !info.isAccessible
    ? "inaccessible"
    : !info.isEnabled
      ? "disabled"
      : "ready";
  return {
    id: app.id,
    name: app.name,
    status,
    isAccessible: info.isAccessible,
    isEnabled: info.isEnabled,
    needsAuth: app.needsAuth,
  };
}

function summarizeAppReadiness(
  apps: readonly CodexPluginAppReadinessApp[],
): CodexPluginAppReadinessStatus {
  if (apps.some((app) => app.status === "inaccessible")) {
    return "inaccessible";
  }
  if (apps.some((app) => app.status === "disabled")) {
    return "disabled";
  }
  if (apps.some((app) => app.status === "missing")) {
    return "missing";
  }
  if (apps.some((app) => app.status === "auth_required")) {
    return "auth_required";
  }
  if (apps.some((app) => app.status === "unknown")) {
    return "unknown";
  }
  return "ready";
}

function readinessCode(status: CodexPluginAppReadinessStatus): CodexPluginAppReadinessCode {
  switch (status) {
    case "inaccessible":
      return "app_inaccessible";
    case "disabled":
      return "app_disabled";
    case "missing":
      return "app_missing";
    case "auth_required":
      return "app_auth_required";
    case "plugin_disabled":
      return "plugin_disabled";
    default:
      return "app_readiness_unknown";
  }
}

function appReadinessMessage(
  plugin: CodexPluginSource,
  apps: readonly CodexPluginAppReadinessApp[],
  status: CodexPluginAppReadinessStatus,
): string {
  const blocking =
    apps.find((app) => app.status === status) ??
    apps.find((app) => app.status !== "ready") ??
    apps[0];
  const appLabel = blocking ? ` app "${blocking.name}"` : " an owned app";
  return `Codex plugin "${plugin.pluginName ?? plugin.name}" owns${appLabel} but the source app inventory reports it is ${blocking?.status ?? "unknown"}; authenticate or enable the app in Codex before migrating it to OpenClaw.`;
}

function pluginNameFromSummary(summary: v2.PluginSummary): string | undefined {
  const candidates = [summary.id, summary.name];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const withoutMarketplaceSuffix = trimmed.endsWith(`@${CODEX_PLUGINS_MARKETPLACE_NAME}`)
      ? trimmed.slice(0, -`@${CODEX_PLUGINS_MARKETPLACE_NAME}`.length)
      : trimmed;
    const pathSegment = withoutMarketplaceSuffix.split("/").at(-1)?.trim();
    const normalized = pathSegment?.toLowerCase().replaceAll(/\s+/gu, "-");
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export async function discoverCodexSource(
  inputOrOptions?: string | CodexSourceDiscoveryOptions,
): Promise<CodexSource> {
  const options =
    typeof inputOrOptions === "string" || inputOrOptions === undefined
      ? { input: inputOrOptions }
      : inputOrOptions;
  const codexHome = resolveHomePath(options.input?.trim() || defaultCodexHome());
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
  const sourcePluginDiscovery = await discoverInstalledCuratedPlugins(codexHome, options);
  const sourcePluginNames = new Set(
    sourcePluginDiscovery.plugins.flatMap((plugin) =>
      plugin.pluginName ? [plugin.pluginName] : [],
    ),
  );
  const cachedPlugins = (await discoverPluginDirs(codexHome)).filter((plugin) => {
    const normalizedName = sanitizePluginName(plugin.name);
    return !sourcePluginNames.has(normalizedName);
  });
  const plugins = [...sourcePluginDiscovery.plugins, ...cachedPlugins].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
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
  const high = Boolean(codexSkills.length || plugins.length || archivePaths.length);
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
    plugins,
    ...(sourcePluginDiscovery.error ? { pluginDiscoveryError: sourcePluginDiscovery.error } : {}),
    archivePaths,
  };
}

export function hasCodexSource(source: CodexSource): boolean {
  return source.confidence !== "low";
}

function sanitizePluginName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, "-");
}
