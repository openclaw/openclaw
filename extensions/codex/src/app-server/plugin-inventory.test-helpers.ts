import { CODEX_PLUGINS_MARKETPLACE_NAME, type CodexPluginConfig } from "./config.js";
import type { v2 } from "./protocol.js";

type PluginsConfig = NonNullable<CodexPluginConfig["codexPlugins"]>;
type PluginEntry = NonNullable<PluginsConfig["plugins"]>[string];

export function codexPluginConfig(options: PluginsConfig = {}): CodexPluginConfig {
  return { codexPlugins: { enabled: true, ...options } };
}

export function curatedPlugin(
  pluginName: string,
  options: Omit<PluginEntry, "marketplaceName" | "pluginName"> = {},
): PluginEntry & { marketplaceName: typeof CODEX_PLUGINS_MARKETPLACE_NAME; pluginName: string } {
  return { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName, ...options };
}

export function asPluginInstalled(listed: v2.PluginListResponse): v2.PluginInstalledResponse {
  const { featuredPluginIds: _featuredPluginIds, ...installed } = listed;
  return installed;
}

export function pluginInstalled(
  plugins: v2.PluginSummary[],
  marketplace: { name?: string; path?: string | null } = {},
): v2.PluginInstalledResponse {
  return asPluginInstalled(pluginList(plugins, marketplace));
}

export function pluginList(
  plugins: v2.PluginSummary[],
  marketplace: { name?: string; path?: string | null } = {},
): v2.PluginListResponse {
  const { name = CODEX_PLUGINS_MARKETPLACE_NAME, path = "/marketplaces/openai-curated" } =
    marketplace;
  return {
    marketplaces: [{ name, path, interface: null, plugins }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

export function pluginSummary(
  id: string,
  overrides: Partial<v2.PluginSummary> = {},
): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
    ...overrides,
  };
}

export function pluginDetail(
  pluginName: string,
  apps: v2.AppSummary[],
  marketplace: {
    marketplaceName?: string;
    marketplacePath?: string | null;
    mcpServers?: string[];
  } = {},
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: marketplace.marketplaceName ?? CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath:
        marketplace.marketplacePath === undefined
          ? "/marketplaces/openai-curated"
          : marketplace.marketplacePath,
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      apps,
      mcpServers: marketplace.mcpServers ?? [],
    },
  };
}

export function appSummary(id: string): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    category: null,
  };
}

export function appInfo(id: string, accessible: boolean, enabled = true): v2.AppInfo {
  return {
    id,
    name: id,
    isAccessible: accessible,
    isEnabled: enabled,
    pluginDisplayNames: [],
  };
}
