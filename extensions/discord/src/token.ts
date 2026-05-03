import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

type DiscordTokenSource = "env" | "config" | "none";

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

function stripBotPrefix(value: string | undefined): string | undefined {
  return value?.replace(/^Bot\s+/i, "") || undefined;
}

/**
 * Resolve an env-backed SecretRef to its actual value, respecting provider
 * configuration and allowlists. Mirrors the pattern used by Telegram token
 * resolution to support `env:<provider>:<VAR>` refs in named accounts.
 */
function resolveEnvSecretRefValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  provider: string;
  id: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(params.id)) {
      throw new Error(
        `Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`,
      );
    }
  } else if (
    params.provider !== resolveDefaultSecretProviderAlias({ secrets: params.cfg?.secrets }, "env")
  ) {
    throw new Error(
      `Secret provider "${params.provider}" is not configured (ref: env:${params.provider}:${params.id}).`,
    );
  }
  return normalizeSecretInputString((params.env ?? process.env)[params.id]);
}

type RuntimeTokenValueResolution =
  | { status: "available"; value: string }
  | { status: "configured_unavailable" }
  | { status: "missing" };

/**
 * Resolve a config token value that may be a plain string or a SecretRef.
 * Uses inspect mode first to avoid throwing on unresolved SecretRefs, then
 * resolves env-backed refs from `process.env`.
 */
function resolveRuntimeTokenValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  value: unknown;
  path: string;
}): RuntimeTokenValueResolution {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return { status: "available", value: resolved.value };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  // SecretRef is configured but not yet resolved — resolve env-backed refs.
  if (resolved.ref.source === "env") {
    const envValue = resolveEnvSecretRefValue({
      cfg: params.cfg,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
    });
    if (envValue) {
      return { status: "available", value: envValue };
    }
    return { status: "configured_unavailable" };
  }
  // Non-env SecretRefs: fall through to strict mode so callers get a clear error.
  resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "strict",
  });
  return { status: "configured_unavailable" };
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

  // Resolve the account token using runtime-aware resolution that handles
  // both plain strings and SecretRef objects (e.g. env:default:DISCORD_BOT_TOKEN_SUBAGENT).
  const accountTokenRaw = (accountCfg as { token?: unknown } | undefined)?.token;
  const accountResolution = resolveRuntimeTokenValue({
    cfg,
    value: accountTokenRaw ?? undefined,
    path: `channels.discord.accounts.${accountId}.token`,
  });
  if (accountResolution.status === "available") {
    const token = stripBotPrefix(accountResolution.value);
    if (token) {
      return { token, source: "config" };
    }
  }
  if (hasAccountToken && accountResolution.status !== "missing") {
    return { token: "", source: "none" };
  }

  // Channel-level token (also may be a SecretRef).
  const configResolution = resolveRuntimeTokenValue({
    cfg,
    value: discordCfg?.token ?? undefined,
    path: "channels.discord.token",
  });
  if (configResolution.status === "available") {
    const token = stripBotPrefix(configResolution.value);
    if (token) {
      return { token, source: "config" };
    }
  }
  if (configResolution.status === "configured_unavailable") {
    return { token: "", source: "none" };
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
