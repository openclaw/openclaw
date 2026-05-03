import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";

type DiscordTokenSource = "env" | "config" | "none";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
};

const DISCORD_DEFAULT_BOT_ENV_VAR = "DISCORD_BOT_TOKEN";

export function normalizeDiscordToken(raw: unknown, _path: string): string | undefined {
  // Use the gentle normalizer so that an unresolved SecretRef object (e.g. the channel
  // startup path reading raw config before secrets are resolved into a runtime snapshot)
  // returns undefined and lets the caller decide whether to fall through to other
  // fallbacks. The strict variant is still appropriate for runtime-snapshot consumers
  // that have already had channel SecretRefs materialized into string tokens.
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

  const topTokenValue = discordCfg?.token ?? undefined;
  const configToken = normalizeDiscordToken(topTokenValue, "channels.discord.token");
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  // If the top-level token is an unresolved SecretRef, only fall through to the
  // process.env DISCORD_BOT_TOKEN fallback when the ref's intent is identical
  // (env source, DISCORD_BOT_TOKEN id). For any other configured SecretRef
  // shape (file, exec, alternate env id) we preserve operator intent and report
  // the token as unavailable rather than silently substituting an unrelated env
  // token, which could otherwise start the wrong bot account.
  const topTokenRef = coerceSecretRef(topTokenValue);
  if (topTokenRef) {
    const matchesEnvFallback =
      topTokenRef.source === "env" && topTokenRef.id === DISCORD_DEFAULT_BOT_ENV_VAR;
    if (!matchesEnvFallback) {
      return { token: "", source: "none" };
    }
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeDiscordToken(
        opts.envToken ?? process.env[DISCORD_DEFAULT_BOT_ENV_VAR],
        DISCORD_DEFAULT_BOT_ENV_VAR,
      )
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
