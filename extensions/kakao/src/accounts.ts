import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import type { ResolvedKakaoAccount, KakaoAccountConfig, KakaoConfig } from "./types.js";
import { resolveKakaoToken } from "./token.js";

function listConfiguredAccountIds(cfg: MoltbotConfig): string[] {
  const accounts = (cfg.channels?.kakao as KakaoConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listKakaoAccountIds(cfg: MoltbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultKakaoAccountId(cfg: MoltbotConfig): string {
  const kakaoConfig = cfg.channels?.kakao as KakaoConfig | undefined;
  if (kakaoConfig?.defaultAccount?.trim()) return kakaoConfig.defaultAccount.trim();
  const ids = listKakaoAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: MoltbotConfig,
  accountId: string,
): KakaoAccountConfig | undefined {
  const accounts = (cfg.channels?.kakao as KakaoConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as KakaoAccountConfig | undefined;
}

function mergeKakaoAccountConfig(cfg: MoltbotConfig, accountId: string): KakaoAccountConfig {
  const raw = (cfg.channels?.kakao ?? {}) as KakaoConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveKakaoAccount(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedKakaoAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.kakao as KakaoConfig | undefined)?.enabled !== false;
  const merged = mergeKakaoAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveKakaoToken(
    params.cfg.channels?.kakao as KakaoConfig | undefined,
    accountId,
  );

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    appKey: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function listEnabledKakaoAccounts(cfg: MoltbotConfig): ResolvedKakaoAccount[] {
  return listKakaoAccountIds(cfg)
    .map((accountId) => resolveKakaoAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
