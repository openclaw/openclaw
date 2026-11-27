import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type JsonRecord = Record<string, unknown>;

function baseUrlFallback(config?: JsonRecord): JsonRecord | undefined {
  return typeof config?.baseUrl === "string" && config.baseUrl.trim()
    ? { baseUrl: config.baseUrl }
    : undefined;
}

export function resolveEffectiveXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const pluginWebSearchBaseUrl = baseUrlFallback(
    resolveProviderWebSearchPluginConfig(config, "xai"),
  );
  const pluginOwned = config?.plugins?.entries?.xai?.config?.xSearch;
  const merged = {
    ...pluginWebSearchBaseUrl,
    ...(isRecord(pluginOwned) ? pluginOwned : undefined),
  };
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

export function setPluginXSearchConfigValue(
  configTarget: OpenClawConfig,
  key: string,
  value: unknown,
): void {
  const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
  const entries = (plugins.entries ??= {});
  const entry = (entries.xai ??= {}) as { config?: Record<string, unknown> };
  const config = (entry.config ??= {});
  const xSearch = (config.xSearch ??= {}) as Record<string, unknown>;
  xSearch[key] = value;
}
