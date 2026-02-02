import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { type ResolvedSpixiAccount, type SpixiAccountConfig } from "./types.js";

export function listSpixiAccountIds(cfg: unknown): string[] {
  // Type guard for config shape
  const channels =
    typeof cfg === "object" &&
    cfg !== null &&
    "channels" in cfg &&
    typeof (cfg as unknown as { channels?: unknown }).channels === "object"
      ? (cfg as unknown as { channels?: unknown }).channels
      : undefined;
  const spixi = channels && typeof channels.spixi === "object" ? channels.spixi : undefined;
  const accounts = spixi && typeof spixi.accounts === "object" ? spixi.accounts : undefined;
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
  // Type guard for config shape
  const channels =
    typeof params.cfg === "object" &&
    params.cfg !== null &&
    "channels" in params.cfg &&
    typeof (params.cfg as unknown as { channels?: unknown }).channels === "object"
      ? (params.cfg as unknown as { channels?: unknown }).channels
      : undefined;
  const spixi = channels && typeof channels.spixi === "object" ? channels.spixi : undefined;
  const accounts = spixi && typeof spixi.accounts === "object" ? spixi.accounts : {};
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = (accounts[accountId] || {}) as SpixiAccountConfig;
  const baseConfig = (spixi || {}) as SpixiAccountConfig;
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
