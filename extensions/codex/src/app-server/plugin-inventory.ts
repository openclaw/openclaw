import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  resolveCodexPluginsConfig,
  type CodexPluginEntryConfig,
  type ResolvedCodexPluginsConfig,
} from "./config.js";
import type { v2 } from "./protocol-generated/typescript/index.js";

export const CODEX_PLUGIN_MARKETPLACE_NAME = "openai-curated";

export type CodexPluginBridgeRequest = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

export type CodexPluginInventoryRecord = {
  key: string;
  toolName: string;
  pluginId: string;
  pluginName: string;
  displayName: string;
  marketplaceName: typeof CODEX_PLUGIN_MARKETPLACE_NAME;
  marketplacePath?: string;
  installed: boolean;
  enabledInCodex: boolean;
  enabledInOpenClaw: boolean;
  sourceInstalled: boolean;
  activationEligible: boolean;
  accessible: boolean;
  authRequired: boolean;
  allowDestructiveActions: boolean;
  summary: v2.PluginSummary;
  configEntry?: CodexPluginEntryConfig;
};

export type CodexPluginInventory = {
  enabled: boolean;
  marketplaceFound: boolean;
  records: CodexPluginInventoryRecord[];
  diagnostics: string[];
};

export function normalizeCodexPluginKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const withoutMarketplace = trimmed.endsWith(`@${CODEX_PLUGIN_MARKETPLACE_NAME}`)
    ? trimmed.slice(0, -1 * `@${CODEX_PLUGIN_MARKETPLACE_NAME}`.length)
    : trimmed;
  return withoutMarketplace.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function codexPluginToolName(raw: string): string {
  const key = normalizeCodexPluginKey(raw).replace(/-/g, "_");
  return `codex_plugin_${key || "plugin"}`;
}

export function buildCodexPluginMention(
  record: Pick<CodexPluginInventoryRecord, "displayName" | "pluginId">,
): string {
  return `[@${record.displayName}](plugin://${record.pluginId})`;
}

export function buildConfiguredCodexPluginRecords(
  pluginConfig?: unknown,
): CodexPluginInventoryRecord[] {
  const config = resolveCodexPluginsConfig({ pluginConfig });
  if (!config.enabled) {
    return [];
  }
  return Object.entries(config.plugins)
    .filter(([key]) => key !== "*")
    .map(([key, entry]) => buildConfiguredCodexPluginRecord(config, key, entry))
    .filter((record): record is CodexPluginInventoryRecord => Boolean(record))
    .toSorted((left, right) => left.toolName.localeCompare(right.toolName));
}

export function resolveCodexPluginEffectivePolicy(params: {
  config: ResolvedCodexPluginsConfig;
  entry?: CodexPluginEntryConfig;
}): { enabled: boolean; allowDestructiveActions: boolean } {
  const wildcard = params.config.plugins["*"];
  const enabled = params.entry?.enabled ?? wildcard?.enabled ?? false;
  const allowDestructiveActions =
    params.entry?.allow_destructive_actions ??
    wildcard?.allow_destructive_actions ??
    params.config.allow_destructive_actions;
  return { enabled, allowDestructiveActions };
}

export async function readCodexPluginInventory(params: {
  pluginConfig?: unknown;
  request: CodexPluginBridgeRequest;
  forceRefetchApps?: boolean;
}): Promise<CodexPluginInventory> {
  const config = resolveCodexPluginsConfig({ pluginConfig: params.pluginConfig });
  if (!config.enabled) {
    return { enabled: false, marketplaceFound: false, records: [], diagnostics: [] };
  }
  const listed = await params.request<v2.PluginListResponse>("plugin/list", {});
  const marketplace = listed.marketplaces.find(
    (entry) => entry.name === CODEX_PLUGIN_MARKETPLACE_NAME,
  );
  if (!marketplace) {
    return {
      enabled: true,
      marketplaceFound: false,
      records: [],
      diagnostics: [`Codex marketplace ${CODEX_PLUGIN_MARKETPLACE_NAME} was not found.`],
    };
  }
  const apps = await readAppsBestEffort(params.request, params.forceRefetchApps === true);
  const records = marketplace.plugins
    .map((plugin) =>
      buildInventoryRecord({
        config,
        plugin,
        marketplacePath: marketplace.path ?? undefined,
        apps,
      }),
    )
    .filter((record): record is CodexPluginInventoryRecord => Boolean(record))
    .toSorted((left, right) => left.toolName.localeCompare(right.toolName));
  return { enabled: true, marketplaceFound: true, records, diagnostics: [] };
}

function buildInventoryRecord(params: {
  config: ResolvedCodexPluginsConfig;
  plugin: v2.PluginSummary;
  marketplacePath?: string;
  apps: v2.AppInfo[];
}): CodexPluginInventoryRecord | undefined {
  const key = normalizeCodexPluginKey(params.plugin.name || params.plugin.id);
  if (!key) {
    return undefined;
  }
  const entry = resolvePluginEntry(params.config.plugins, params.plugin, key);
  const sourceInstalled =
    entry?.marketplaceName === CODEX_PLUGIN_MARKETPLACE_NAME && Boolean(entry.pluginName?.trim());
  const policy = resolveCodexPluginEffectivePolicy({ config: params.config, entry });
  const displayName = params.plugin.interface?.displayName?.trim() || params.plugin.name || key;
  const accessible = isPluginAccessible(params.plugin, params.apps, displayName);
  const authRequired = params.plugin.installed && params.plugin.enabled && !accessible;
  return {
    key,
    toolName: codexPluginToolName(key),
    pluginId: params.plugin.id,
    pluginName: entry?.pluginName ?? params.plugin.name,
    displayName,
    marketplaceName: CODEX_PLUGIN_MARKETPLACE_NAME,
    ...(params.marketplacePath ? { marketplacePath: params.marketplacePath } : {}),
    installed: params.plugin.installed,
    enabledInCodex: params.plugin.enabled,
    enabledInOpenClaw: policy.enabled,
    sourceInstalled,
    activationEligible: policy.enabled && sourceInstalled,
    accessible,
    authRequired,
    allowDestructiveActions: policy.allowDestructiveActions,
    summary: params.plugin,
    ...(entry ? { configEntry: entry } : {}),
  };
}

function buildConfiguredCodexPluginRecord(
  config: ResolvedCodexPluginsConfig,
  rawKey: string,
  entry: CodexPluginEntryConfig,
): CodexPluginInventoryRecord | undefined {
  const pluginName = entry.pluginName?.trim() || rawKey.trim();
  const key = normalizeCodexPluginKey(pluginName || rawKey);
  if (!key) {
    return undefined;
  }
  const policy = resolveCodexPluginEffectivePolicy({ config, entry });
  if (!policy.enabled) {
    return undefined;
  }
  const displayName = pluginName;
  const pluginId = `${CODEX_PLUGIN_MARKETPLACE_NAME}/${pluginName}`;
  const summary = {
    id: pluginId,
    name: pluginName,
    installed: false,
    enabled: false,
    interface: { displayName },
  } as v2.PluginSummary;
  return {
    key,
    toolName: codexPluginToolName(key),
    pluginId,
    pluginName,
    displayName,
    marketplaceName: CODEX_PLUGIN_MARKETPLACE_NAME,
    installed: false,
    enabledInCodex: false,
    enabledInOpenClaw: true,
    sourceInstalled: entry.marketplaceName === CODEX_PLUGIN_MARKETPLACE_NAME,
    activationEligible: entry.marketplaceName === CODEX_PLUGIN_MARKETPLACE_NAME,
    accessible: false,
    authRequired: false,
    allowDestructiveActions: policy.allowDestructiveActions,
    summary,
    configEntry: entry,
  };
}

function resolvePluginEntry(
  plugins: Record<string, CodexPluginEntryConfig>,
  plugin: v2.PluginSummary,
  key: string,
): CodexPluginEntryConfig | undefined {
  const candidates = new Set([
    key,
    normalizeCodexPluginKey(plugin.name),
    normalizeCodexPluginKey(plugin.id),
  ]);
  for (const [rawKey, entry] of Object.entries(plugins)) {
    if (rawKey === "*") {
      continue;
    }
    if (candidates.has(normalizeCodexPluginKey(rawKey))) {
      return entry;
    }
    if (entry.pluginName && candidates.has(normalizeCodexPluginKey(entry.pluginName))) {
      return entry;
    }
  }
  return undefined;
}

async function readAppsBestEffort(
  request: CodexPluginBridgeRequest,
  forceRefetch: boolean,
): Promise<v2.AppInfo[]> {
  try {
    const apps = await request<v2.AppsListResponse>("app/list", { forceRefetch });
    return apps.data;
  } catch {
    return [];
  }
}

function isPluginAccessible(
  plugin: v2.PluginSummary,
  apps: v2.AppInfo[],
  displayName: string,
): boolean {
  if (!plugin.installed || !plugin.enabled) {
    return false;
  }
  const relatedApps = apps.filter((app) =>
    app.pluginDisplayNames.some((name) => name === displayName || name === plugin.name),
  );
  if (relatedApps.length === 0) {
    return true;
  }
  return relatedApps.every((app) => app.isAccessible && app.isEnabled);
}

export function createCodexPluginToolDefinition(params: {
  record: CodexPluginInventoryRecord;
  execute: AnyAgentTool["execute"];
}): AnyAgentTool {
  return {
    name: params.record.toolName,
    label: params.record.displayName,
    description: `Use the Codex ${params.record.displayName} plugin.`,
    parameters: Type.Object(
      {
        request: Type.String({ description: "The plugin task to perform." }),
      },
      { additionalProperties: false },
    ),
    execute: params.execute,
  };
}
