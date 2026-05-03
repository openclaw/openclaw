import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
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

// Returns true iff `cfg.secrets.providers[providerName]` (or, if absent, the
// resolved default secrets-provider alias for env) is configured to honor a
// SecretRef whose intent is `env:<providerName>:<id>` — i.e. the provider's
// source is `env` and any allowlist permits `id`. This mirrors Telegram's
// resolveEnvSecretRefValue policy gate (extensions/telegram/src/token.ts) so
// that a Discord channel-startup env-fallback only fires when the operator-
// configured SecretRef policy actually permits reading process.env[id].
function envSecretRefMatchesProviderPolicy(
  cfg: OpenClawConfig | undefined,
  providerName: string,
  id: string,
): boolean {
  const providerConfig = cfg?.secrets?.providers?.[providerName];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      return false;
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(id)) {
      return false;
    }
    return true;
  }
  // Provider not explicitly configured — only allow fallthrough when this is
  // the default env-provider alias the runtime would have resolved anyway.
  const defaultEnvAlias = resolveDefaultSecretProviderAlias({ secrets: cfg?.secrets }, "env");
  return providerName === defaultEnvAlias;
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
  // process.env DISCORD_BOT_TOKEN fallback when the ref's intent matches it AND
  // the operator's secret-provider policy permits the env read. We check three
  // things, in order, and short-circuit to source=none on any miss:
  //
  //   1. ref.source === "env"                     — non-env refs (file, exec)
  //                                                 must be resolved upstream;
  //                                                 we will not substitute env
  //                                                 for a vault/file lookup.
  //   2. ref.id === DISCORD_DEFAULT_BOT_ENV_VAR   — env refs pointing at a
  //                                                 different env var (e.g.
  //                                                 DISCORD_PROD_BOT_TOKEN)
  //                                                 must not be silently
  //                                                 substituted by the bare
  //                                                 DISCORD_BOT_TOKEN fallback.
  //   3. provider policy allows env:<provider>:<id> — mirrors Telegram's
  //                                                   resolveEnvSecretRefValue
  //                                                   gate so a misconfigured
  //                                                   secrets provider (wrong
  //                                                   source or excluded by an
  //                                                   allowlist) cannot bypass
  //                                                   operator policy via the
  //                                                   channel env fallback.
  //
  // Anything else preserves operator intent and surfaces a user-actionable
  // "Discord bot token missing" error from createDiscordRestClient instead of
  // crashing channel startup with the internal SecretRef contract error.
  const topTokenRef = coerceSecretRef(topTokenValue, cfg?.secrets?.defaults);
  if (topTokenRef) {
    const matchesEnvFallback =
      topTokenRef.source === "env" &&
      topTokenRef.id === DISCORD_DEFAULT_BOT_ENV_VAR &&
      envSecretRefMatchesProviderPolicy(cfg, topTokenRef.provider, topTokenRef.id);
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
