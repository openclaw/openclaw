import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import {
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
  type SecretInputStringResolution,
} from "openclaw/plugin-sdk/secret-input";

type DiscordTokenSource = "env" | "config" | "none";
type DiscordCredentialStatus = SecretInputStringResolution["status"];

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
  tokenStatus: DiscordCredentialStatus;
};

export function normalizeDiscordToken(raw: unknown, path: string): string | undefined {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^Bot\s+/i, "");
}

function inspectDiscordToken(
  raw: unknown,
  path: string,
): {
  token: string;
  tokenStatus: DiscordCredentialStatus;
} {
  const resolved = resolveSecretInputString({ value: raw, path, mode: "inspect" });
  if (resolved.status !== "available") {
    return { token: "", tokenStatus: resolved.status };
  }
  return { token: resolved.value.replace(/^Bot\s+/i, ""), tokenStatus: "available" };
}

export function resolveDiscordToken(
  cfg: OpenClawConfig,
  opts: { accountId?: string | null; envToken?: string | null } = {},
): DiscordTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const discordCfg = cfg?.channels?.discord;
  const accountCfg = resolveAccountEntry(discordCfg?.accounts, accountId);
  const hasAccountToken = Boolean(
    accountCfg &&
    Object.prototype.hasOwnProperty.call(accountCfg as Record<string, unknown>, "token"),
  );
  const inspectedAccountToken = inspectDiscordToken(
    (accountCfg as { token?: unknown } | undefined)?.token,
    `channels.discord.accounts.${accountId}.token`,
  );
  const accountToken = inspectedAccountToken.token;
  if (accountToken) {
    return {
      token: accountToken,
      source: "config",
      tokenStatus: inspectedAccountToken.tokenStatus,
    };
  }
  if (hasAccountToken) {
    return {
      token: inspectedAccountToken.token,
      source: inspectedAccountToken.tokenStatus === "configured_unavailable" ? "config" : "none",
      tokenStatus: inspectedAccountToken.tokenStatus,
    };
  }

  const inspectedConfigToken = inspectDiscordToken(discordCfg?.token, "channels.discord.token");
  const configToken = inspectedConfigToken.token;
  if (configToken) {
    return {
      token: configToken,
      source: "config",
      tokenStatus: inspectedConfigToken.tokenStatus,
    };
  }
  if (inspectedConfigToken.tokenStatus === "configured_unavailable") {
    return {
      token: inspectedConfigToken.token,
      source: "config",
      tokenStatus: "configured_unavailable",
    };
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
