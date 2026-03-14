import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/lanxin";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/lanxin";
import type { LanxinConfig, ResolvedLanxinAccount } from "./types.js";

function resolveLanxinCredentials(
  cfg?: LanxinConfig,
): { appId: string; appSecret: string; aesKey?: string } | null {
  const appId = typeof cfg?.appId === "string" ? cfg.appId.trim() : undefined;
  const appSecret = normalizeResolvedSecretInputString({
    value: cfg?.appSecret,
    path: "channels.lanxin.appSecret",
  });
  const aesKey = typeof cfg?.aesKey === "string" ? cfg.aesKey.trim() : undefined;
  if (!appId || !appSecret) return null;
  return { appId, appSecret, aesKey };
}

function resolveApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function listLanxinAccountIds(_cfg: ClawdbotConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultLanxinAccountId(_cfg: ClawdbotConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveLanxinAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedLanxinAccount {
  const cfg = params.cfg.channels?.lanxin as LanxinConfig | undefined;
  const creds = resolveLanxinCredentials(cfg);
  const enabled = cfg?.enabled !== false;
  const apiBaseUrl = resolveApiBaseUrl(cfg?.apiBaseUrl);

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(creds?.appId && creds?.appSecret && creds?.aesKey && apiBaseUrl),
    name: typeof cfg?.name === "string" ? cfg.name.trim() || undefined : undefined,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    aesKey: creds?.aesKey,
    apiBaseUrl,
    config: cfg ?? {},
  };
}

export function listEnabledLanxinAccounts(cfg: ClawdbotConfig): ResolvedLanxinAccount[] {
  const account = resolveLanxinAccount({ cfg });
  return account.enabled && account.configured ? [account] : [];
}
