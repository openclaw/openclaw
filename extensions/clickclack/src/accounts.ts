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
import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-resolution-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
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
      (hasConfiguredAccountValue(channel.token) ||
        Boolean(channel.tokenFile?.trim()) ||
        Boolean(process.env.CLICKCLACK_BOT_TOKEN?.trim())) &&
      channel.workspace?.trim(),
    );
  },
});

export { DEFAULT_ACCOUNT_ID, listClickClackAccountIds, resolveDefaultClickClackAccountId };

export function resolveClickClackAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): ClickClackAccountConfig {
  const channel = cfg.channels?.clickclack;
  const merged = resolveMergedAccountConfig<ClickClackAccountConfig>({
    channelConfig: cfg.channels?.clickclack as ClickClackAccountConfig | undefined,
    accounts: channel?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
  const account = resolveNormalizedAccountEntry(channel?.accounts, accountId, normalizeAccountId);
  const accountTokenFile = account?.tokenFile?.trim();
  if (accountTokenFile) {
    return {
      ...merged,
      token: account?.token,
      tokenFile: accountTokenFile,
    };
  }
  if (hasConfiguredAccountValue(account?.token)) {
    return {
      ...merged,
      token: account?.token,
      tokenFile: undefined,
    };
  }
  return merged;
}

function clickClackTokenPath(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? "channels.clickclack.token"
    : `channels.clickclack.accounts.${accountId}.token`;
}

function clickClackTokenFilePath(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? "channels.clickclack.tokenFile"
    : `channels.clickclack.accounts.${accountId}.tokenFile`;
}

function readClickClackTokenFile(tokenFile: string, accountId: string): string {
  return (
    tryReadSecretFileSync(tokenFile, clickClackTokenFilePath(accountId), {
      rejectSymlink: true,
    }) ?? ""
  );
}

function defaultEnvToken(params: { accountId: string; env?: NodeJS.ProcessEnv }): string {
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return "";
  }
  return normalizeSecretInputString((params.env ?? process.env).CLICKCLACK_BOT_TOKEN) ?? "";
}

function resolveClickClackToken(params: {
  cfg: CoreConfig;
  value: unknown;
  tokenFile?: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const tokenFile = params.tokenFile?.trim();
  if (tokenFile) {
    return readClickClackTokenFile(tokenFile, params.accountId);
  }
  const resolved = resolveSecretInputString({
    value: params.value,
    path: clickClackTokenPath(params.accountId),
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status !== "available") {
    if (resolved.status === "missing" && params.accountId === DEFAULT_ACCOUNT_ID) {
      return defaultEnvToken(params);
    }
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
      return normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "";
    }
    return "";
  }
  return (
    normalizeResolvedSecretInputString({
      value: resolved.value,
      path: clickClackTokenPath(params.accountId),
    }) ?? ""
  );
}

async function resolveClickClackRuntimeToken(params: {
  cfg: CoreConfig;
  value: unknown;
  tokenFile?: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const tokenFile = params.tokenFile?.trim();
  if (tokenFile) {
    return readClickClackTokenFile(tokenFile, params.accountId);
  }

  const path = clickClackTokenPath(params.accountId);
  const inspected = resolveSecretInputString({
    value: params.value,
    path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env ?? process.env,
    value: params.value,
    path,
  });
  if (resolved.value) {
    return resolved.value;
  }
  if (inspected.status === "missing") {
    return defaultEnvToken(params);
  }
  return "";
}

function hasConfiguredClickClackToken(params: {
  token: string;
  value: unknown;
  tokenFile?: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return Boolean(
    params.token ||
    params.tokenFile?.trim() ||
    hasConfiguredAccountValue(params.value) ||
    defaultEnvToken(params),
  );
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
  const merged = resolveClickClackAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.clickclack?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = merged.baseUrl?.trim().replace(/\/$/, "") ?? "";
  const token = resolveClickClackToken({
    cfg: params.cfg,
    value: merged.token,
    tokenFile: merged.tokenFile,
    accountId,
    env: params.env,
  });
  const workspace = merged.workspace?.trim() ?? "";
  const hasToken = hasConfiguredClickClackToken({
    token,
    value: merged.token,
    tokenFile: merged.tokenFile,
    accountId,
    env: params.env,
  });
  return {
    accountId,
    enabled,
    configured: Boolean(baseUrl && hasToken && workspace),
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
    // Durable activity rows require an agent_activity:write bot token scope on
    // the ClickClack side, so this stays a per-account opt-in (default off),
    // matching the streaming-progress commentary opt-in precedent.
    agentActivity: merged.agentActivity === true,
    // Command-menu sync is best effort and current bot:write tokens include
    // commands:write, so resolved accounts default on unless explicitly disabled.
    commandMenu: merged.commandMenu !== false,
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
    },
  };
}

/**
 * Builds the runtime account snapshot with SecretRefs materialized for gateway
 * startup and outbound delivery.
 */
export async function resolveClickClackRuntimeAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedClickClackAccount> {
  const account = resolveClickClackAccount(params);
  const token = await resolveClickClackRuntimeToken({
    cfg: params.cfg,
    value: account.config.token,
    tokenFile: account.config.tokenFile,
    accountId: account.accountId,
    env: params.env,
  });
  return {
    ...account,
    token,
    configured: Boolean(account.baseUrl && token && account.workspace),
  };
}

/**
 * Returns all enabled accounts, including the implicit default account when
 * legacy top-level ClickClack config is present.
 */
export function listEnabledClickClackAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listClickClackAccountIds(cfg)
    .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
