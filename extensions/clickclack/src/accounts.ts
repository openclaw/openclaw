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
type ClickClackSecretRefSource = "env" | "file" | "exec";

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

function validateClickClackSecretRefProvider(params: {
  cfg: CoreConfig;
  source: ClickClackSecretRefSource;
  provider: string;
  id: string;
}): void {
  const providerConfig = params.cfg.secrets?.providers?.[params.provider];
  if (providerConfig) {
    if (providerConfig.source !== params.source) {
      throw new Error(
        `Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "${params.source}".`,
      );
    }
    if (
      providerConfig.source === "env" &&
      providerConfig.allowlist &&
      !providerConfig.allowlist.includes(params.id)
    ) {
      throw new Error(
        `Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`,
      );
    }
    return;
  }

  if (
    params.source === "env" &&
    params.provider === resolveDefaultSecretProviderAlias({ secrets: params.cfg.secrets }, "env")
  ) {
    return;
  }
  throw new Error(
    `Secret provider "${params.provider}" is not configured (ref: ${params.source}:${params.provider}:${params.id}).`,
  );
}

function resolveClickClackToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): { value: string; configuredRef: boolean } {
  const resolved = resolveSecretInputString({
    value: params.value,
    path:
      params.accountId === DEFAULT_ACCOUNT_ID
        ? "channels.clickclack.token"
        : `channels.clickclack.accounts.${params.accountId}.token`,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return {
      value:
        normalizeResolvedSecretInputString({
          value: resolved.value,
          path: "channels.clickclack.token",
        }) ?? "",
      configuredRef: false,
    };
  }
  if (resolved.status === "configured_unavailable") {
    // Synchronous env-var lookup stays here so inspect/status paths can resolve
    // the value without spawning resolvers. file/exec refs can't be resolved
    // synchronously — runtime paths must call resolveClickClackRuntimeToken.
    if (resolved.ref.source === "env") {
      validateClickClackSecretRefProvider({
        cfg: params.cfg,
        source: resolved.ref.source,
        provider: resolved.ref.provider,
        id: resolved.ref.id,
      });
      return {
        value: normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]) ?? "",
        configuredRef: false,
      };
    }
    validateClickClackSecretRefProvider({
      cfg: params.cfg,
      source: resolved.ref.source,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
    });
    // file/exec SecretRef: configured, but value is only available via the
    // async runtime resolver. Status paths treat the account as configured so
    // startup doesn't mark ClickClack "missing"; runtime paths must call
    // resolveClickClackRuntimeToken before using the token.
    return { value: "", configuredRef: true };
  }
  return { value: "", configuredRef: false };
}

/**
 * Resolves the runtime ClickClack token value for gateway/outbound paths.
 * Uses the configured SecretRef runtime resolver so `exec`/`file` refs are
 * actually evaluated, instead of only the synchronous `env` special case.
 */
export async function resolveClickClackRuntimeToken(params: {
  cfg: CoreConfig;
  value: unknown;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const path =
    params.accountId === DEFAULT_ACCOUNT_ID
      ? "channels.clickclack.token"
      : `channels.clickclack.accounts.${params.accountId}.token`;
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env ?? process.env,
    value: params.value,
    path,
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
  const tokenResolution = enabled
    ? resolveClickClackToken({
        cfg: params.cfg,
        value: merged.token,
        accountId,
        env: params.env,
      })
    : { value: "", configuredRef: false };
  const token = tokenResolution.value;
  const workspace = merged.workspace?.trim() ?? "";
  // Configured file/exec SecretRefs count only after provider validation; env
  // refs still need a present value. Runtime paths materialize non-env tokens
  // through resolveClickClackRuntimeToken before using them.
  const configured = Boolean(baseUrl && workspace && (token || tokenResolution.configuredRef));
  return {
    accountId,
    enabled,
    configured,
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
export function listEnabledClickClackAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listClickClackAccountIds(cfg)
    .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
