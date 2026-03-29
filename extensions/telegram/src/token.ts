import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { TelegramAccountConfig } from "../runtime-api.js";

export type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = BaseTokenResolution & {
  source: TelegramTokenSource;
};

type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveTelegramToken(
  cfg?: OpenClawConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const telegramCfg = cfg?.channels?.telegram;

  // Account IDs are normalized for routing (e.g. lowercased). Config keys may not
  // be normalized, so resolve per-account config by matching normalized IDs.
  const resolveAccountCfg = (id: string): TelegramAccountConfig | undefined => {
    const accounts = telegramCfg?.accounts;
    return Array.isArray(accounts)
      ? undefined
      : resolveNormalizedAccountEntry(accounts, id, normalizeAccountId);
  };

  const accountCfg = resolveAccountCfg(
    accountId !== DEFAULT_ACCOUNT_ID ? accountId : DEFAULT_ACCOUNT_ID,
  );

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
      !!accounts &&
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

  const accountTokenFile = accountCfg?.tokenFile?.trim();
  if (accountTokenFile) {
    const token = tryReadSecretFileSync(
      accountTokenFile,
      `channels.telegram.accounts.${accountId}.tokenFile`,
      { rejectSymlink: true },
    );
    if (token) {
      return { token, source: "tokenFile" };
    }
    opts.logMissingFile?.(
      `channels.telegram.accounts.${accountId}.tokenFile not found or unreadable: ${accountTokenFile}`,
    );
    return { token: "", source: "none" };
  }

  const accountToken = normalizeResolvedSecretInputString({
    value: accountCfg?.botToken,
    path: `channels.telegram.accounts.${accountId}.botToken`,
  });
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const tokenFile = telegramCfg?.tokenFile?.trim();
  if (tokenFile) {
    const token = tryReadSecretFileSync(tokenFile, "channels.telegram.tokenFile", {
      rejectSymlink: true,
    });
    if (token) {
      return { token, source: "tokenFile" };
    }
    opts.logMissingFile?.(`channels.telegram.tokenFile not found or unreadable: ${tokenFile}`);
    return { token: "", source: "none" };
  }

  const configToken = normalizeResolvedSecretInputString({
    value: telegramCfg?.botToken,
    path: "channels.telegram.botToken",
  });
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
