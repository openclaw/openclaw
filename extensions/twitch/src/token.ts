import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type TwitchTokenResolution = {
  token: string;
};

function normalizeTwitchToken(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("oauth:") ? trimmed : `oauth:${trimmed}`;
}

// Root credentials precede accounts.default; the environment is a default-account fallback only.
export function resolveTwitchToken(
  cfg?: OpenClawConfig,
  accountIdInput?: string | null,
): TwitchTokenResolution {
  const accountId = normalizeAccountId(accountIdInput);

  const twitchCfg = cfg?.channels?.twitch;
  const accounts = twitchCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountCfg = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);

  let token: string | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    token = normalizeTwitchToken(
      (typeof twitchCfg?.accessToken === "string" ? twitchCfg.accessToken : undefined) ||
        (accountCfg?.accessToken as string | undefined),
    );
  } else {
    token = normalizeTwitchToken(accountCfg?.accessToken as string | undefined);
  }

  if (token) {
    return { token };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeTwitchToken(process.env.OPENCLAW_TWITCH_ACCESS_TOKEN)
    : undefined;
  if (envToken) {
    return { token: envToken };
  }

  return { token: "" };
}
