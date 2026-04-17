import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "./api.js";
import { type A2ABrokerPartyRef, createA2ABrokerClient } from "./standalone-broker-client.js";

export type A2ABrokerAdapterEntryConfig = {
  baseUrl?: unknown;
  edgeSecret?: unknown;
  requester?: unknown;
};

export type A2ABrokerAdapterPluginEntry = {
  enabled?: boolean;
  config?: A2ABrokerAdapterEntryConfig;
};

export type A2ABrokerAdapterPluginRuntimeConfig = {
  plugins?: {
    enabled?: boolean;
    allow?: unknown;
    deny?: unknown;
    entries?: Record<string, A2ABrokerAdapterPluginEntry | undefined>;
  };
};

export type ResolvedA2ABrokerAdapterPluginConfig = {
  enabled: boolean;
  explicitlyActivated: boolean;
  baseUrl?: string;
  edgeSecret?: string;
  requester?: A2ABrokerPartyRef;
};

export function resolveA2ABrokerAdapterPluginConfig(
  config?: A2ABrokerAdapterPluginRuntimeConfig,
): ResolvedA2ABrokerAdapterPluginConfig {
  const plugins = config?.plugins;
  const entry = plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  const pluginConfig = entry?.config;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : [];
  const deny = Array.isArray(plugins?.deny) ? plugins.deny : [];
  const allowlisted = allow.includes(A2A_BROKER_ADAPTER_PLUGIN_ID);
  const allowlistBlocked = allow.length > 0 && !allowlisted;
  const explicitlyEnabled = entry?.enabled === true;
  const disabled =
    plugins?.enabled === false ||
    deny.includes(A2A_BROKER_ADAPTER_PLUGIN_ID) ||
    entry?.enabled === false ||
    allowlistBlocked;

  return {
    enabled: !disabled,
    explicitlyActivated: !disabled && (explicitlyEnabled || allowlisted),
    baseUrl: readOptionalString(pluginConfig?.baseUrl),
    edgeSecret: readOptionalString(pluginConfig?.edgeSecret),
    requester: resolveRequester(pluginConfig?.requester),
  };
}

export function shouldUseStandaloneBrokerSessionsSendAdapter(
  config?: A2ABrokerAdapterPluginRuntimeConfig,
): boolean {
  const pluginConfig = resolveA2ABrokerAdapterPluginConfig(config);
  return pluginConfig.enabled && pluginConfig.explicitlyActivated && Boolean(pluginConfig.baseUrl);
}

export function createConfiguredA2ABrokerClient(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  deps: {
    createClient?: typeof createA2ABrokerClient;
  } = {},
) {
  const pluginConfig = resolveA2ABrokerAdapterPluginConfig(config);
  if (!pluginConfig.enabled) {
    throw new Error(
      "Standalone A2A broker adapter is disabled; selection must stay behind the plugin activation gate",
    );
  }
  if (!pluginConfig.baseUrl) {
    throw new Error(
      "Standalone A2A broker adapter requires plugins.entries.a2a-broker-adapter.config.baseUrl",
    );
  }

  const createClient = deps.createClient ?? createA2ABrokerClient;
  return createClient({
    baseUrl: pluginConfig.baseUrl,
    ...(pluginConfig.edgeSecret ? { edgeSecret: pluginConfig.edgeSecret } : {}),
    ...(pluginConfig.requester ? { requester: pluginConfig.requester } : {}),
  });
}

function resolveRequester(value: unknown): A2ABrokerPartyRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = readOptionalString(record.id);
  if (!id) {
    return undefined;
  }
  const kind = readOptionalString(record.kind) as A2ABrokerPartyRef["kind"] | undefined;
  const role = readOptionalString(record.role) as A2ABrokerPartyRef["role"] | undefined;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(role ? { role } : {}),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
