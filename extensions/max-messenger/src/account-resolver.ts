import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { MAX_BOT_TOKEN_ENV } from "./constants.js";
import type { CoreConfig, MaxAccountConfig, MaxTokenSource, ResolvedMaxAccount } from "./types.js";

const DEFAULT_API_ROOT = "https://platform-api.max.ru";

const {
  listAccountIds: listMaxAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultMaxAccountId,
} = createAccountListHelpers("max-messenger", { normalizeAccountId });

export { resolveDefaultMaxAccountId };

export function listMaxAccountIds(cfg: CoreConfig): string[] {
  return listMaxAccountIdsInternal(cfg);
}

function mergeMaxAccountConfig(cfg: CoreConfig, accountId: string): MaxAccountConfig {
  return resolveMergedAccountConfig<MaxAccountConfig>({
    channelConfig: cfg.channels?.["max-messenger"] as MaxAccountConfig | undefined,
    accounts: cfg.channels?.["max-messenger"]?.accounts as
      | Record<string, Partial<MaxAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

function resolveMaxToken(
  cfg: CoreConfig,
  opts: { accountId: string },
): { token: string; source: MaxTokenSource } {
  const accountId = opts.accountId;
  const merged = mergeMaxAccountConfig(cfg, accountId);

  // tokenFile takes precedence — secret-managers point here for rotation safety.
  const tokenFile = merged.tokenFile?.trim();
  if (tokenFile) {
    const fromFile = tryReadSecretFileSync(
      tokenFile,
      `channels.max-messenger.accounts.${accountId}.tokenFile`,
      { rejectSymlink: true },
    );
    if (fromFile) {
      return { token: fromFile, source: "tokenFile" };
    }
    return { token: "", source: "none" };
  }

  // Inline `token` field (SecretInput — string or SecretRef).
  const inlineToken = normalizeResolvedSecretInputString({
    value: merged.token,
    path: `channels.max-messenger.accounts.${accountId}.token`,
  });
  if (inlineToken) {
    return { token: inlineToken, source: "config" };
  }

  // Env fallback only for the default account (mirror Telegram + nextcloud-talk).
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = normalizeOptionalString(process.env[MAX_BOT_TOKEN_ENV]);
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}

export function resolveMaxAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMaxAccount {
  const baseEnabled = params.cfg.channels?.["max-messenger"]?.enabled !== false;
  const requested = params.accountId ?? resolveDefaultMaxAccountId(params.cfg);

  const resolve = (accountId: string): ResolvedMaxAccount => {
    const merged = mergeMaxAccountConfig(params.cfg, accountId);
    const enabled = baseEnabled && merged.enabled !== false;
    const tokenResolution = resolveMaxToken(params.cfg, { accountId });
    const apiRoot = merged.apiRoot?.trim().replace(/\/$/, "") || DEFAULT_API_ROOT;

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      apiRoot,
      config: merged,
    };
  };

  return resolveAccountWithDefaultFallback({
    accountId: requested,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultMaxAccountId(params.cfg),
  });
}
