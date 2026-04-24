import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export type DiscordTokenSource = "env" | "config" | "none";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
};

export function normalizeDiscordToken(raw: unknown, path: string): string | undefined {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^Bot\s+/i, "");
}

export function resolveDiscordToken(
  cfg?: OpenClawConfig,
  opts: {
    accountId?: string | null;
    envToken?: string | null;
    explicit?: boolean;
  } = {},
): DiscordTokenResolution {
  // Treat as explicit only when the caller intentionally targeted this account.
  // Direct callers that supply an accountId are treated as explicit by default
  // (back-compat); indirect callers such as resolveDiscordAccount forward
  // `explicit: false` when the id was filled in from channels.discord.defaultAccount.
  const hasProvidedAccountId =
    typeof opts.accountId === "string" && opts.accountId.trim().length > 0;
  const explicitAccountId =
    hasProvidedAccountId && opts.explicit !== false
      ? normalizeAccountId(opts.accountId)
      : undefined;
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
  if (explicitAccountId && explicitAccountId !== DEFAULT_ACCOUNT_ID) {
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
