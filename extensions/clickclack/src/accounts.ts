/**
 * Resolves ClickClack account configuration from root channel config, named
 * account overrides, and secret-provider references.
 */
import {
  createAccountListHelpers,
  hasConfiguredAccountValue,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import {
  normalizeSecretInputString,
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClickClackAccountConfig, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const DEFAULT_RECONNECT_MS = 1_500;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 60_000;

const {
  listAccountIds: listClickClackAccountIds,
  resolveDefaultAccountId: resolveDefaultClickClackAccountId,
} = createAccountListHelpers("clickclack", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.clickclack;
    return Boolean(
      channel?.baseUrl?.trim() &&
      hasConfiguredAccountValue(channel.token) &&
      channel.workspace?.trim(),
    );
  },
});

export { DEFAULT_ACCOUNT_ID, listClickClackAccountIds, resolveDefaultClickClackAccountId };

function resolveMergedClickClackAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): ClickClackAccountConfig {
  return resolveMergedAccountConfig<ClickClackAccountConfig>({
    channelConfig: cfg.channels?.clickclack as ClickClackAccountConfig | undefined,
    accounts: cfg.channels?.clickclack?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

function clickClackTokenPath(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? "channels.clickclack.token"
    : `channels.clickclack.accounts.${accountId}.token`;
}

function resolveClickClackToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): { token: string; configured: boolean } {
  const path = clickClackTokenPath(params.accountId);
  const resolved = resolveSecretInputString({
    value: params.value,
    path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status !== "available") {
    if (resolved.status === "configured_unavailable" && resolved.ref.source === "env") {
      const providerConfig = params.cfg.secrets?.providers?.[resolved.ref.provider];
      if (providerConfig) {
        if (providerConfig.source !== "env") {
          throw new Error(
            `Secret provider "${resolved.ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
          );
        }
        if (providerConfig.allowlist && !providerConfig.allowlist.includes(resolved.ref.id)) {
          throw new Error(
            `Environment variable "${resolved.ref.id}" is not allowlisted in secrets.providers.${resolved.ref.provider}.allowlist.`,
          );
        }
      } else if (
        resolved.ref.provider !==
        resolveDefaultSecretProviderAlias({ secrets: params.cfg.secrets }, "env")
      ) {
        throw new Error(
          `Secret provider "${resolved.ref.provider}" is not configured (ref: env:${resolved.ref.provider}:${resolved.ref.id}).`,
        );
      }
      const token = normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "";
      return { token, configured: Boolean(token) };
    }
    return { token: "", configured: resolved.status === "configured_unavailable" };
  }
  const token =
    normalizeResolvedSecretInputString({
      value: resolved.value,
      path,
    }) ?? "";
  return { token, configured: Boolean(token) };
}

async function resolveRuntimeClickClackToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env ?? process.env,
    value: params.value,
    path: clickClackTokenPath(params.accountId),
    unresolvedReasonStyle: "detailed",
  });
  return resolved.value ?? "";
}

/**
 * Builds the normalized account snapshot used by gateway, outbound delivery,
 * status reporting, and channel routing.
 */
export function resolveClickClackAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedClickClackAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveMergedClickClackAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.clickclack?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = merged.baseUrl?.trim().replace(/\/$/, "") ?? "";
  const tokenResolution = resolveClickClackToken({
    cfg: params.cfg,
    value: merged.token,
    accountId,
    env: params.env,
  });
  const token = tokenResolution.token;
  const workspace = merged.workspace?.trim() ?? "";
  return {
    accountId,
    enabled,
    configured: Boolean(baseUrl && tokenResolution.configured && workspace),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    token,
    workspace,
    botUserId: normalizeOptionalString(merged.botUserId),
    agentId: normalizeOptionalString(merged.agentId),
    replyMode: merged.replyMode === "model" ? "model" : "agent",
    model: normalizeOptionalString(merged.model),
    systemPrompt: normalizeOptionalString(merged.systemPrompt),
    timeoutSeconds: merged.timeoutSeconds,
    toolsAllow: merged.toolsAllow,
    defaultTo: merged.defaultTo?.trim() || "channel:general",
    allowFrom: merged.allowFrom ?? ["*"],
    reconnectMs: resolveIntegerOption(merged.reconnectMs, DEFAULT_RECONNECT_MS, {
      min: MIN_RECONNECT_MS,
      max: MAX_RECONNECT_MS,
    }),
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
    },
  };
}

/**
 * Returns all enabled accounts, including the implicit default account when
 * legacy top-level ClickClack config is present.
 */
export async function resolveRuntimeClickClackAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedClickClackAccount> {
  const account = resolveClickClackAccount(params);
  const token = await resolveRuntimeClickClackToken({
    cfg: params.cfg,
    value: account.config.token,
    accountId: account.accountId,
    env: params.env,
  });
  return {
    ...account,
    token,
    configured: Boolean(account.baseUrl && token && account.workspace),
  };
}

export function listEnabledClickClackAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listClickClackAccountIds(cfg)
    .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
