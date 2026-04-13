import {
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

// Include MINIMAX_OAUTH_TOKEN and MINIMAX_API_KEY so the web_search
// provider can discover OAuth-managed credentials, not just Coding Plan
// keys. The chat provider (provider-registration.ts:255) already lists
// both — the web search provider was missing them (#65768).
const MINIMAX_CODING_PLAN_ENV_VARS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
] as const;

function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  return searchConfig?.apiKey;
}

function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

export function createMiniMaxWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax Search",
    hint: "Structured results via MiniMax Coding Plan search API",
    credentialLabel: "MiniMax Coding Plan key",
    envVars: [...MINIMAX_CODING_PLAN_ENV_VARS],
    placeholder: "sk-cp-...",
    signupUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    docsUrl: "https://docs.openclaw.ai/tools/minimax-search",
    autoDetectOrder: 15,
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.minimax.config.webSearch.apiKey"],
    getCredentialValue: getTopLevelCredentialValue,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "minimax")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "minimax", "apiKey", value);
    },
    createTool: () => null,
  };
}
