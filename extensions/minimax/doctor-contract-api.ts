// MiniMax doctor contract repairs API-key auth settings written before the header split.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

const OFFICIAL_MINIMAX_ANTHROPIC_BASE_URLS = new Set([
  "https://api.minimax.io/anthropic",
  "https://api.minimaxi.com/anthropic",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\/+$/, "").toLowerCase();
  return normalized || undefined;
}

function hasLegacyMinimaxApiKeyAuthHeader(value: unknown): boolean {
  const provider = asRecord(value);
  if (!provider || provider.authHeader !== true || provider.api !== "anthropic-messages") {
    return false;
  }
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  return baseUrl !== undefined && OFFICIAL_MINIMAX_ANTHROPIC_BASE_URLS.has(baseUrl);
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["models", "providers", "minimax"],
    message:
      'models.providers.minimax.authHeader uses the retired Bearer mode for MiniMax API keys; run "openclaw doctor --fix" to restore X-Api-Key authentication.',
    match: hasLegacyMinimaxApiKeyAuthHeader,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const provider = cfg.models?.providers?.minimax;
  if (!hasLegacyMinimaxApiKeyAuthHeader(provider)) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextProvider = next.models?.providers?.minimax;
  if (!nextProvider) {
    return { config: cfg, changes: [] };
  }
  nextProvider.authHeader = false;
  return {
    config: next,
    changes: [
      "Updated models.providers.minimax.authHeader from true to false for X-Api-Key authentication.",
    ],
  };
}
