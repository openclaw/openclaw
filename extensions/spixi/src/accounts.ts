import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { type ResolvedSpixiAccount, type SpixiAccountConfig } from "./types.js";

type SpixiChannelConfig = SpixiAccountConfig & {
  accounts?: Record<string, SpixiAccountConfig>;
};

function getSpixiChannelConfig(cfg: unknown): SpixiChannelConfig | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const channels = (cfg as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return undefined;
  }
  const spixi = (channels as { spixi?: unknown }).spixi;
  if (!spixi || typeof spixi !== "object") {
    return undefined;
  }
  return spixi as SpixiChannelConfig;
}

export function listSpixiAccountIds(cfg: unknown): string[] {
  const accounts = getSpixiChannelConfig(cfg)?.accounts;
  if (!accounts) {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveSpixiAccount(params: {
  cfg: unknown;
  accountId?: string | null;
}): ResolvedSpixiAccount {
  const spixi = getSpixiChannelConfig(params.cfg) ?? {};
  const accounts = spixi.accounts ?? {};
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = (accounts[accountId] || {}) as SpixiAccountConfig;
  const baseConfig = spixi as SpixiAccountConfig;
  const merged = { ...baseConfig, ...accountConfig };

  // Check if configured (has any meaningful config set)
  const configured = Boolean(
    merged.mqttHost?.trim() ||
    merged.quixiApiUrl?.trim() ||
    merged.myWalletAddress?.trim() ||
    typeof merged.mqttPort === "number",
  );

  return {
    accountId,
    enabled: merged.enabled !== false,
    configured,
    name: merged.name,
    config: merged,
  };
}
