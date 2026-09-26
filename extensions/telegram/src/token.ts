import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/routing";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import { resolveDefaultTelegramAccountId } from "./account-selection.js";

type CredentialUnavailableDiagnostic = Extract<
  ReturnType<typeof tryReadSecretFileSync>,
  { status: "configured_unavailable" }
>["diagnostic"];

type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = BaseTokenResolution & {
  source: TelegramTokenSource;
  credentialDiagnostics?: CredentialUnavailableDiagnostic[];
};

type RuntimeTokenValueResolution =
  | { status: "available"; value: string }
  | { status: "configured_unavailable" }
  | { status: "missing" };

function resolveEnvSecretRefValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  provider: string;
  id: string;
}): string | undefined {
  // Share admission with inspection while retaining strict diagnostics below.
  if (canResolveEnvSecretRefInReadOnlyPath(params)) {
    return normalizeSecretInputString(process.env[params.id]);
  }
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    throw new Error(
      `Secret provider "${params.provider}" is not configured (ref: env:${params.provider}:${params.id}).`,
    );
  }
  if (providerConfig.source !== "env") {
    throw new Error(
      `Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "env".`,
    );
  }
  throw new Error(
    `Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`,
  );
}

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
    return {
      status: "available",
      value: resolved.value,
    };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source === "env") {
    const envValue = resolveEnvSecretRefValue({
      cfg: params.cfg,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
    });
    if (envValue) {
      return {
        status: "available",
        value: envValue,
      };
    }
    return { status: "configured_unavailable" };
  }
  // Runtime resolution stays strict for non-env SecretRefs.
  resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "strict",
  });
  return { status: "configured_unavailable" };
}

type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveTelegramToken(
  cfg?: OpenClawConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const requestedAccountId = normalizeOptionalAccountId(opts.accountId);
  const accountId =
    requestedAccountId ?? (cfg ? resolveDefaultTelegramAccountId(cfg) : DEFAULT_ACCOUNT_ID);
  const telegramCfg = cfg?.channels?.telegram;

  // Account IDs are normalized for routing (e.g. lowercased). Config keys may not
  // be normalized, so resolve per-account config by matching normalized IDs.
  const resolveAccountCfg = (id: string): TelegramAccountConfig | undefined => {
    const accounts = telegramCfg?.accounts;
    return Array.isArray(accounts)
      ? undefined
      : resolveNormalizedAccountEntry(accounts, id, normalizeAccountId);
  };

  const accountCfg = resolveAccountCfg(accountId);

  // When a non-default accountId is explicitly specified but not found in config,
  // decide whether to fall through to channel-level defaults based on whether
  // the config has an explicit accounts section (multi-bot setup).
  //
  // Multi-bot: accounts section exists with entries → block fallthrough to prevent
  // routing via the wrong bot's token.
  //
  // Single-bot: no accounts section (or empty) → allow fallthrough so that
  // binding-created accountIds inherit the channel-level token.
  // See: https://github.com/openclaw/openclaw/issues/53876
  if (accountId !== DEFAULT_ACCOUNT_ID && !accountCfg) {
    const accounts = telegramCfg?.accounts;
    const hasConfiguredAccounts =
      Boolean(accounts) &&
      typeof accounts === "object" &&
      !Array.isArray(accounts) &&
      Object.keys(accounts).length > 0;
    if (hasConfiguredAccounts) {
      opts.logMissingFile?.(
        `channels.telegram.accounts: unknown accountId "${accountId}" — not found in config, refusing channel-level fallback`,
      );
      return { token: "", source: "none" };
    }
  }

  for (const { config, path } of [
    { config: accountCfg, path: `channels.telegram.accounts.${accountId}` },
    { config: telegramCfg, path: "channels.telegram" },
  ]) {
    const tokenFile = config?.tokenFile?.trim();
    if (tokenFile) {
      const result = tryReadSecretFileSync(
        tokenFile,
        "Telegram bot token",
        { rejectSymlink: true },
        { configPath: `${path}.tokenFile` },
      );
      if (result.status === "available") {
        return { token: result.value, source: "tokenFile" };
      }
      opts.logMissingFile?.(`${path}.tokenFile is configured but unavailable`);
      return {
        token: "",
        source: "tokenFile",
        credentialDiagnostics: [result.diagnostic],
      };
    }
    const token = resolveRuntimeTokenValue({
      cfg,
      value: config?.botToken,
      path: `${path}.botToken`,
    });
    if (token.status === "available") {
      return { token: token.value, source: "config" };
    }
    if (token.status === "configured_unavailable") {
      return { token: "", source: "none" };
    }
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
