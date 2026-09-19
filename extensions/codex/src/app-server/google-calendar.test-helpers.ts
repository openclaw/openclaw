import { expect, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { v2 } from "./protocol.js";
import { threadStartResult, turnStartResult } from "./run-attempt-test-harness.js";

export const GOOGLE_CALENDAR_PLUGIN_CONFIG = {
  codexPlugins: {
    enabled: true,
    plugins: {
      "google-calendar": {
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    },
  },
} as const;

export type GoogleCalendarCacheKeyInput = {
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  agentDir: string;
};

export function googleCalendarAppInfo(isEnabled: boolean): v2.AppInfo {
  return {
    id: "google-calendar-app",
    name: "Google Calendar",
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled,
    pluginDisplayNames: [],
  };
}

const GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT = {
  marketplaces: [
    {
      name: "openai-curated",
      path: "/marketplaces/openai-curated",
      interface: null,
      plugins: [
        {
          id: "google-calendar",
          name: "google-calendar",
          source: { type: "remote" },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          interface: null,
        },
      ],
    },
  ],
  marketplaceLoadErrors: [],
} satisfies v2.PluginInstalledResponse;

const GOOGLE_CALENDAR_PLUGIN_LIST_RESULT = {
  ...GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT,
  featuredPluginIds: [],
} satisfies v2.PluginListResponse;

const GOOGLE_CALENDAR_PLUGIN_READ_RESULT = {
  plugin: {
    marketplaceName: "openai-curated",
    marketplacePath: "/marketplaces/openai-curated",
    summary: {
      id: "google-calendar",
      name: "google-calendar",
      source: { type: "remote" },
      installed: true,
      enabled: true,
      installPolicy: "AVAILABLE",
      authPolicy: "ON_USE",
      availability: "AVAILABLE",
      interface: null,
    },
    description: null,
    skills: [],
    apps: [
      {
        id: "google-calendar-app",
        name: "Google Calendar",
        description: null,
        installUrl: null,
        category: null,
      },
    ],
    mcpServers: ["google-calendar"],
  },
} as const;

export function createGoogleCalendarRequest(
  appInventory?: (method: "app/installed" | "app/read") => unknown,
) {
  let threadAppEnabled = false;
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "config/read") {
      expect((params as { includeLayers?: boolean } | undefined)?.includeLayers).toBe(true);
      return { config: {}, layers: [] };
    }
    if (
      method === "app/installed" &&
      typeof (params as { threadId?: unknown } | undefined)?.threadId === "string"
    ) {
      return codexAppInventoryResponse("app/installed", [googleCalendarAppInfo(threadAppEnabled)]);
    }
    if ((method === "app/installed" || method === "app/read") && appInventory) {
      return appInventory(method);
    }
    if (method === "plugin/installed") {
      return GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT;
    }
    if (method === "plugin/list") {
      return GOOGLE_CALENDAR_PLUGIN_LIST_RESULT;
    }
    if (method === "plugin/read") {
      return GOOGLE_CALENDAR_PLUGIN_READ_RESULT;
    }
    if (method === "thread/start") {
      const config = (params as { config?: { apps?: Record<string, { enabled?: boolean }> } })
        ?.config;
      threadAppEnabled = config?.apps?.["google-calendar-app"]?.enabled === true;
      return threadStartResult("thread-1");
    }
    if (method === "turn/start") {
      return turnStartResult("turn-1", "inProgress");
    }
    return undefined;
  });
}

export async function primeGoogleCalendarAppInventory(
  key: string,
  isEnabled: boolean,
): Promise<void> {
  defaultCodexAppInventoryCache.clear();
  await defaultCodexAppInventoryCache.refreshNow({
    key,
    request: async (method, params) =>
      codexAppInventoryResponse(method, [googleCalendarAppInfo(isEnabled)], params),
  });
}
