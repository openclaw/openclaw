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
const MINIMAX_API_KEY_PROVIDER_IDS = ["minimax", "minimax-cn"] as const;

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

export const legacyConfigRules: LegacyConfigRule[] = MINIMAX_API_KEY_PROVIDER_IDS.map(
  (providerId) => ({
    path: ["models", "providers", providerId],
    message: `models.providers.${providerId}.authHeader uses the retired Bearer mode for MiniMax API keys; run "openclaw doctor --fix" to restore X-Api-Key authentication.`,
    match: hasLegacyMinimaxApiKeyAuthHeader,
  }),
);

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const providerIds = MINIMAX_API_KEY_PROVIDER_IDS.filter((providerId) =>
    hasLegacyMinimaxApiKeyAuthHeader(cfg.models?.providers?.[providerId]),
  );
  if (providerIds.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  for (const providerId of providerIds) {
    const nextProvider = next.models?.providers?.[providerId];
    if (!nextProvider) {
      continue;
    }
    nextProvider.authHeader = false;
    changes.push(
      `Updated models.providers.${providerId}.authHeader from true to false for X-Api-Key authentication.`,
    );
  }
  return { config: next, changes };
}
