import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountEntry,
} from "openclaw/plugin-sdk/routing";
import {
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { selectDiscordRuntimeConfig } from "./runtime-config.js";

type DiscordTokenSource = "env" | "config" | "none";
export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
  tokenStatus: DiscordCredentialStatus;
};

function stripDiscordBotPrefix(token: string): string {
  return token.replace(/^Bot\s+/i, "");
}

export function normalizeDiscordToken(raw: unknown, path: string): string | undefined {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  return trimmed ? stripDiscordBotPrefix(trimmed) : undefined;
}

function resolveDiscordTokenValue(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): DiscordTokenResolution | undefined {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const token = stripDiscordBotPrefix(resolved.value);
    return token ? { token, source: "config", tokenStatus: "available" } : undefined;
  }
  if (resolved.status === "configured_unavailable") {
    return { token: "", source: "config", tokenStatus: "configured_unavailable" };
  }
  return undefined;
}

export function resolveDiscordToken(
  cfg: OpenClawConfig,
  opts: { accountId?: string | null; envToken?: string | null } = {},
): DiscordTokenResolution {
  const selectedCfg = selectDiscordRuntimeConfig(cfg);
  const accountId = normalizeAccountId(opts.accountId);
  const discordCfg = selectedCfg?.channels?.discord;
  const accountCfg = resolveAccountEntry(discordCfg?.accounts, accountId);
  const hasAccountToken = Boolean(
    accountCfg && Object.hasOwn(accountCfg as Record<string, unknown>, "token"),
  );
  const accountToken = resolveDiscordTokenValue({
    cfg: selectedCfg,
    value: (accountCfg as { token?: unknown } | undefined)?.token,
    path: `channels.discord.accounts.${accountId}.token`,
  });
  if (accountToken) {
    return accountToken;
  }
  if (hasAccountToken) {
    return { token: "", source: "none", tokenStatus: "missing" };
  }

  const configToken = resolveDiscordTokenValue({
    cfg: selectedCfg,
    value: discordCfg?.token,
    path: "channels.discord.token",
  });
  if (configToken) {
    return configToken;
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN")
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env", tokenStatus: "available" };
  }

  return { token: "", source: "none", tokenStatus: "missing" };
}
