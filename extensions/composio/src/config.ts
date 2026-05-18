import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveProviderWebSearchPluginConfig,
  resolveWebSearchProviderCredential,
  setProviderWebSearchPluginConfigValue,
} from "openclaw/plugin-sdk/provider-web-search";

const COMPOSIO_CREDENTIAL_PATH = "plugins.entries.composio.config.webSearch.apiKey";

export function resolveComposioApiKey(config?: OpenClawConfig): string | undefined {
  return resolveWebSearchProviderCredential({
    config,
    providerId: "composio",
    envVars: ["COMPOSIO_API_KEY"],
    configPaths: [COMPOSIO_CREDENTIAL_PATH, "tools.web.search.composioApiKey"],
  });
}

export function setComposioApiKey(config: OpenClawConfig, value: unknown): void {
  setProviderWebSearchPluginConfigValue(config, "composio", "apiKey", value);
}

export function resolveConfiguredComposioApiKey(config?: OpenClawConfig): unknown {
  return resolveProviderWebSearchPluginConfig(config, "composio")?.apiKey;
}
