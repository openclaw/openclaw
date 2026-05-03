import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";

type DiscordTokenSource = "env" | "config" | "none";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
};

export function normalizeDiscordToken(raw: unknown, _path: string): string | undefined {
  // Use the gentle normalizer so that an unresolved SecretRef object (e.g. the channel
  // startup path reading raw config before secrets are resolved into a runtime snapshot)
  // returns undefined and lets the caller fall through to account/env fallbacks instead
  // of throwing. The strict variant is still appropriate for runtime-snapshot consumers.
  const trimmed = normalizeSecretInputString(raw);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^Bot\s+/i, "");
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
  const accountToken = normalizeDiscordToken(
    (accountCfg as { token?: unknown } | undefined)?.token ?? undefined,
    `channels.discord.accounts.${accountId}.token`,
  );
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }
  if (hasAccountToken) {
    return { token: "", source: "none" };
  }

  const configToken = normalizeDiscordToken(
    discordCfg?.token ?? undefined,
    "channels.discord.token",
  );
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN")
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
