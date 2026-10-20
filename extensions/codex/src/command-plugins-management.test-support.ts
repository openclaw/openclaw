import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import type { CodexPluginsConfigBlock, CodexPluginsManagementIO } from "./command-plugin-config.js";
import type { handleCodexPluginsSubcommand } from "./command-plugins-management.js";

export type CodexPluginsManagementRuntime = NonNullable<
  Parameters<typeof handleCodexPluginsSubcommand>[3]
>;

export function pluginCatalog(
  plugins: v2.PluginSummary[],
  name = "company-tools",
  path?: string,
): v2.PluginListResponse {
  return {
    marketplaces: [{ name, ...(path ? { path } : {}), plugins }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

export function pluginSummary(
  name: string,
  marketplace: string,
  overrides: Partial<v2.PluginSummary> = {},
) {
  return {
    id: `${name}@${marketplace}`,
    name,
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    availability: "AVAILABLE",
    authPolicy: "ON_USE",
    ...(overrides.remotePluginId ? { mustShowInstallationInterstitial: false } : {}),
    interface: { shortDescription: "Security review <@team> *instructions*" },
    ...overrides,
  } satisfies v2.PluginSummary;
}

export function pluginRuntime(
  params: {
    marketplace?: string;
    marketplacePath?: string;
    pluginName?: string;
    remotePluginId?: string;
    mustShowInstallationInterstitial?: boolean | null;
    installed?: boolean;
    enabled?: boolean;
    install?: CodexPluginsManagementRuntime["install"];
    refresh?: CodexPluginsManagementRuntime["refresh"];
    setupAllowed?: boolean;
  } = {},
) {
  const { marketplace = "company-tools", pluginName = "security-review" } = params;
  const { remotePluginId, mustShowInstallationInterstitial = false } = params;
  const summary = pluginSummary(pluginName, marketplace, {
    installed: params.installed ?? false,
    enabled: params.enabled ?? false,
    ...(remotePluginId ? { remotePluginId, mustShowInstallationInterstitial } : {}),
  });
  const listed = pluginCatalog([summary], marketplace, params.marketplacePath);
  let pendingApps: v2.AppSummary[] = [];
  const policy = { enabled: true, marketplaceName: marketplace, pluginName };
  return {
    workspaceDir: vi.fn(async () => "/repo/company"),
    list: vi.fn(async () => listed),
    install: vi.fn(async (request: v2.PluginInstallParams) => {
      const response = await (params.install?.(request) ?? {
        authPolicy: "ON_USE" as const,
        appsNeedingAuth: [],
      });
      pendingApps = response.appsNeedingAuth;
      return response;
    }),
    withContext: async (run) =>
      run({
        workspaceDir: "/repo/company",
        agentId: "test",
        appCacheKey: "test",
        validateCurrent: async () => {},
        current: { enabled: true, plugins: { [`${pluginName}@${marketplace}`]: policy } },
        request: async <TResponse>(method: string): Promise<TResponse> => {
          const responses: Record<string, unknown> = {
            "account/read": { account: { type: "chatgpt" } },
            "experimentalFeature/list": {
              data: [{ name: "apps", enabled: true }],
              nextCursor: null,
            },
            "plugin/installed": listed,
            "plugin/read": { plugin: { summary, apps: pendingApps, mcpServers: [] } },
            "app/installed": { apps: [] },
            "app/read": {
              apps: params.setupAllowed === false ? [] : pendingApps,
              missingAppIds: params.setupAllowed === false ? pendingApps.map((app) => app.id) : [],
            },
          };
          if (!(method in responses)) {
            throw new Error(`Unexpected setup method: ${method}`);
          }
          return responses[method] as TResponse;
        },
      }),
    ...(params.refresh ? { refresh: params.refresh } : {}),
  } satisfies CodexPluginsManagementRuntime;
}

type CodexPluginConfigEntry = NonNullable<CodexPluginsConfigBlock["plugins"]>[string];

export function inMemoryIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
) {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: structuredClone(initial),
  };
  const mutate: CodexPluginsManagementIO["mutate"] = async (update, assertCurrent) => {
    assertCurrent?.();
    update(store);
  };
  return {
    mutate,
    readConfig: async () => structuredClone(store),
    current: () => structuredClone(store.plugins ?? {}),
    currentConfig: () => structuredClone(store),
  };
}

export const fakeCtx: PluginCommandContext = {
  args: "",
  config: {},
  channel: "test",
  isAuthorizedSender: true,
  senderIsOwner: true,
  commandBody: "/codex plugins",
  requestConversationBinding: async () => ({ status: "error", message: "unused" }),
  detachConversationBinding: async () => ({ removed: false }),
  getCurrentConversationBinding: async () => null,
};

export function presentationButtons(result: PluginCommandResult) {
  return (result.presentation?.blocks ?? []).flatMap((block) =>
    block.type === "buttons" ? block.buttons : [],
  );
}

export function buttonCommands(result: PluginCommandResult): string[] {
  return presentationButtons(result).flatMap((button) =>
    button.action?.type === "command" ? [button.action.command] : [],
  );
}
