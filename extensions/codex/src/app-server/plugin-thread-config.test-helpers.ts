import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse, nativeAppToolsResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import { appInfo, appSummary, pluginList, pluginSummary } from "./plugin-inventory.test-helpers.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { JsonObject, v2 } from "./protocol.js";

export function pluginDetail(
  pluginName: string,
  apps: v2.AppSummary[],
  mcpServers: string[] = [],
  marketplace: { marketplaceName?: string; marketplacePath?: string | null } = {},
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: marketplace.marketplaceName ?? CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath:
        marketplace.marketplacePath === undefined
          ? "/marketplaces/openai-curated"
          : marketplace.marketplacePath,
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers,
    },
  };
}

export async function buildReadyGoogleCalendarThreadConfig(
  pluginConfig: unknown,
  nativeConfig: JsonObject = {},
  nativeTools: JsonObject = { read_event: { annotations: { destructiveHint: false } } },
): Promise<Awaited<ReturnType<typeof buildCodexPluginThreadConfig>>> {
  const appCache = new CodexAppInventoryCache();
  await appCache.refreshNow({
    key: "runtime",
    nowMs: 0,
    request: async (method, params) =>
      codexAppInventoryResponse(method, [appInfo("google-calendar-app", true)], params),
  });

  return buildCodexPluginThreadConfig({
    pluginConfig,
    appCache,
    appCacheKey: "runtime",
    nowMs: 1,
    request: async (method) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
      }
      if (method === "config/read") {
        return { config: nativeConfig, layers: [] };
      }
      if (method === "mcpServerStatus/list") {
        return nativeAppToolsResponse("google-calendar-app", nativeTools);
      }
      throw new Error(`unexpected request ${method}`);
    },
  });
}
