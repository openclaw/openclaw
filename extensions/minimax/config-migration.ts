import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MINIMAX_API_BASE_URL, MINIMAX_CN_API_BASE_URL } from "./model-definitions.js";
import { buildMinimaxPortalProvider } from "./provider-catalog.js";

const LEGACY_MINIMAX_PORTAL_BASE_URLS = new Set([MINIMAX_API_BASE_URL, MINIMAX_CN_API_BASE_URL]);

export function migrateLegacyMinimaxPortalModels(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.["minimax-portal"];
  if (
    !provider ||
    !Array.isArray(provider.models) ||
    provider.models.length !== 0 ||
    provider.api !== "anthropic-messages" ||
    provider.authHeader !== true ||
    typeof provider.baseUrl !== "string" ||
    !LEGACY_MINIMAX_PORTAL_BASE_URLS.has(provider.baseUrl)
  ) {
    return null;
  }

  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: {
          ...config.models?.providers,
          "minimax-portal": {
            ...provider,
            models: buildMinimaxPortalProvider().models,
          },
        },
      },
    },
    changes: ["restored the MiniMax OAuth model catalog for a legacy empty provider entry"],
  };
}
