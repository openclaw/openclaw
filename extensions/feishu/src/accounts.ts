import {
  type OpenClawConfig as ClawdbotConfig,
  createAccountListHelpers,
  hasConfiguredAccountValue,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-resolution";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString as normalizeString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  FeishuAccountConfig,
  FeishuConfig,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";

type MergedFeishuAccountConfig = FeishuConfig & FeishuAccountConfig;

const {
  listAccountIds: listFeishuAccountIds,
  resolveDefaultAccountId: resolveDefaultFeishuAccountId,
  resolveAccountConfig: resolveMergedFeishuAccountConfig,
} = createAccountListHelpers<MergedFeishuAccountConfig>("feishu", {
  allowUnlistedDefaultAccount: true,
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["tools"],
  hasImplicitDefaultAccount: (cfg) => {
    const feishu = cfg.channels?.feishu;
    return hasConfiguredAccountValue(feishu?.appId) && hasConfiguredAccountValue(feishu?.appSecret);
  },
});

export { listFeishuAccountIds, resolveDefaultFeishuAccountId };

type FeishuCredentialResolutionMode = "inspect" | "strict";
type FeishuResolvedSecretRef = NonNullable<ReturnType<typeof coerceSecretRef>>;

export class FeishuSecretRefUnavailableError extends Error {
  constructor(path: string, ref: FeishuResolvedSecretRef) {
    super(
      `${path}: unresolved SecretRef "${ref.source}:${ref.provider}:${ref.id}". ` +
        "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
    this.name = "FeishuSecretRefUnavailableError";
  }
}

function resolveFeishuSecretLike(params: {
  cfg?: ClawdbotConfig;
  value: unknown;
  path: string;
  mode: FeishuCredentialResolutionMode;
}): string | undefined {
  const asString = normalizeString(params.value);
  if (asString) {
    return asString;
  }

  const ref = coerceSecretRef(params.value, params.cfg?.secrets?.defaults);
  if (!ref) {
    return undefined;
  }

  if (params.mode === "inspect") {
    if (
      ref.source === "env" &&
      canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: ref.provider,
        id: ref.id,
      })
    ) {
      return normalizeString(process.env[ref.id]);
    }
    return undefined;
  }

  throw new FeishuSecretRefUnavailableError(params.path, ref);
}

function resolveFeishuBaseCredentials(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
  rootConfig?: ClawdbotConfig,
) {
  const appId = resolveFeishuSecretLike({
    cfg: rootConfig,
    value: cfg?.appId,
    path: "channels.feishu.appId",
    mode,
  });
  const appSecret = resolveFeishuSecretLike({
    cfg: rootConfig,
    value: cfg?.appSecret,
    path: "channels.feishu.appSecret",
    mode,
  });

  if (!appId || !appSecret) {
    return null;
  }

  return {
    appId,
    appSecret,
    // SDK and streaming clients must receive the same scheme-normalized destination.
    domain: cfg?.domain?.replace(/^https:/i, "https:") ?? "feishu",
  };
}

function resolveFeishuEventSecrets(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
  rootConfig?: ClawdbotConfig,
) {
  return {
    encryptKey:
      (cfg?.connectionMode ?? "websocket") === "webhook"
        ? resolveFeishuSecretLike({
            cfg: rootConfig,
            value: cfg?.encryptKey,
            path: "channels.feishu.encryptKey",
            mode,
          })
        : normalizeString(cfg?.encryptKey),
    verificationToken: resolveFeishuSecretLike({
      cfg: rootConfig,
      value: cfg?.verificationToken,
      path: "channels.feishu.verificationToken",
      mode,
    }),
  };
}

export function mergeFeishuAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): MergedFeishuAccountConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const merged = resolveMergedFeishuAccountConfig(cfg, accountId);
  const topTools = feishuCfg?.tools;
  if (merged.tools === undefined && topTools !== undefined) {
    return { ...merged, tools: topTools };
  }
  if (topTools?.bitable === false) {
    return {
      ...merged,
      tools: {
        ...merged.tools,
        bitable: false,
      },
    };
  }
  return merged;
}

export function resolveFeishuCredentials(
  cfg?: FeishuConfig,
  options?: { mode?: FeishuCredentialResolutionMode; rootConfig?: ClawdbotConfig },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const mode = options?.mode ?? "strict";
  const base = resolveFeishuBaseCredentials(cfg, mode, options?.rootConfig);
  if (!base) {
    return null;
  }
  return { ...base, ...resolveFeishuEventSecrets(cfg, mode, options?.rootConfig) };
}

export function inspectFeishuCredentials(cfg?: FeishuConfig, rootConfig?: ClawdbotConfig) {
  return resolveFeishuCredentials(cfg, { mode: "inspect", rootConfig });
}

function buildResolvedFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  baseMode: FeishuCredentialResolutionMode;
  eventSecretMode: FeishuCredentialResolutionMode;
}): ResolvedFeishuAccount {
  const explicitAccountKey = normalizeString(params.accountId);
  const accountId =
    explicitAccountKey !== undefined
      ? normalizeAccountId(explicitAccountKey)
      : resolveDefaultFeishuAccountId(params.cfg);
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  // Merge with the exact authored key: an explicit or default alias that matches
  // a configured key by normalization must resolve that account's own
  // configuration and credentials, never silently inherit the root account.
  const merged = mergeFeishuAccountConfig(
    params.cfg,
    resolveListedFeishuAccountKey(params.cfg, explicitAccountKey ?? accountId),
  );
  const baseCreds = resolveFeishuBaseCredentials(merged, params.baseMode, params.cfg);
  const eventSecrets = resolveFeishuEventSecrets(merged, params.eventSecretMode, params.cfg);

  return {
    accountId,
    enabled: feishuCfg?.enabled !== false && merged.enabled !== false,
    configured: Boolean(baseCreds),
    name: normalizeString(merged.name),
    appId: baseCreds?.appId,
    appSecret: baseCreds?.appSecret,
    encryptKey: eventSecrets.encryptKey,
    verificationToken: eventSecrets.verificationToken,
    domain: baseCreds?.domain ?? "feishu",
    config: merged,
  };
}

/** Match an explicitly supplied account id to its exact configured key.
 * Punctuation-bearing keys normalize differently from their raw spelling, so a
 * normalized alias must map back to the configured key it matches. */
function resolveListedFeishuAccountKey(cfg: ClawdbotConfig, accountId: string): string {
  const trimmed = accountId.trim();
  const listedIds = listFeishuAccountIds(cfg);
  if (listedIds.includes(trimmed)) {
    return trimmed;
  }
  const normalized = normalizeOptionalAccountId(trimmed);
  if (!normalized) {
    return trimmed;
  }
  return (
    listedIds.find((listedId) => normalizeOptionalAccountId(listedId) === normalized) ?? trimmed
  );
}

/**
 * Resolve a read-only Feishu account snapshot for CLI/config surfaces.
 * Unresolved SecretRefs are treated as unavailable instead of throwing.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "inspect",
    eventSecretMode: "inspect",
  });
}

/**
 * Resolve a runtime Feishu account.
 * Required app credentials stay strict; event-only secrets can be required by callers.
 */
export function resolveFeishuRuntimeAccount(
  params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  },
  options?: { requireEventSecrets?: boolean },
): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "strict",
    eventSecretMode: options?.requireEventSecrets ? "strict" : "inspect",
  });
}

export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
