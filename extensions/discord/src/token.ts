import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountEntry,
} from "openclaw/plugin-sdk/routing";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

type DiscordTokenSource = "env" | "config" | "none";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
};

const stripDiscordBotPrefix = (value: string) => value.replace(/^Bot\s+/i, "");

export function normalizeDiscordToken(raw: unknown, path: string): string | undefined {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  return trimmed ? stripDiscordBotPrefix(trimmed) : undefined;
}

function resolveDiscordEnvSecretRefValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  provider: string;
  id: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const prov = params.cfg?.secrets?.providers?.[params.provider];
  if (prov) {
    if (prov.source !== "env") {
      throw new Error(
        `Secret provider "${params.provider}" has source "${prov.source}" but ref requests "env".`,
      );
    }
    if (prov.allowlist && !prov.allowlist.includes(params.id)) {
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

function resolveDiscordConfiguredToken(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  value: unknown;
  path: string;
}) {
  const d = params.cfg?.secrets?.defaults;
  const r = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: d,
    mode: "inspect",
  });
  if (r.status === "available") {
    return { status: "available" as const, value: stripDiscordBotPrefix(r.value) };
  }
  if (r.status === "missing") {
    return { status: "missing" as const };
  }
  if (r.ref.source !== "env") {
    resolveSecretInputString({
      value: params.value,
      path: params.path,
      defaults: d,
      mode: "strict",
    });
    return { status: "configured_unavailable" as const };
  }
  const envVal = resolveDiscordEnvSecretRefValue({
    cfg: params.cfg,
    provider: r.ref.provider,
    id: r.ref.id,
  });
  return envVal
    ? { status: "available" as const, value: stripDiscordBotPrefix(envVal) }
    : { status: "configured_unavailable" as const };
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
  const accountResolved = resolveDiscordConfiguredToken({
    cfg,
    value: (accountCfg as { token?: unknown } | undefined)?.token,
    path: `channels.discord.accounts.${accountId}.token`,
  });
  if (accountResolved.status === "available") {
    return { token: accountResolved.value, source: "config" };
  }
  if (accountResolved.status === "configured_unavailable" || hasAccountToken) {
    return { token: "", source: "none" };
  }
  const channelResolved = resolveDiscordConfiguredToken({
    cfg,
    value: discordCfg?.token ?? undefined,
    path: "channels.discord.token",
  });
  if (channelResolved.status === "available") {
    return { token: channelResolved.value, source: "config" };
  }
  if (channelResolved.status === "configured_unavailable") {
    return { token: "", source: "none" };
  }
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN")
    : undefined;
  return envToken ? { token: envToken, source: "env" } : { token: "", source: "none" };
}
