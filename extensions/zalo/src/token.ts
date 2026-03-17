import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/infra-runtime";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/zalo";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
import type { ZaloConfig } from "./types.js";

export type ZaloTokenResolution = BaseTokenResolution & {
  source: "env" | "config" | "configFile" | "none";
};

function readTokenFromFile(tokenFile: string | undefined): string {
  return tryReadSecretFileSync(tokenFile, "Zalo token file", { rejectSymlink: true }) ?? "";
}

export function resolveZaloToken(
  config: ZaloConfig | undefined,
  accountId?: string | null,
  options?: { allowUnresolvedSecretRef?: boolean },
): ZaloTokenResolution {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const resolveAccountConfig = (id: string): ZaloConfig | undefined => {
    const accounts = baseConfig?.accounts;
    if (!accounts || typeof accounts !== "object") {
      return undefined;
    }
    const direct = accounts[id] as ZaloConfig | undefined;
    if (direct) {
      return direct;
    }
    const normalized = normalizeAccountId(id);
    const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
    return matchKey ? ((accounts as Record<string, ZaloConfig>)[matchKey] ?? undefined) : undefined;
  };
  const accountConfig = resolveAccountConfig(resolvedAccountId);
  const accountHasBotToken = Boolean(
    accountConfig && Object.prototype.hasOwnProperty.call(accountConfig, "botToken"),
  );

  if (accountConfig && accountHasBotToken) {
    const token = options?.allowUnresolvedSecretRef
      ? normalizeSecretInputString(accountConfig.botToken)
      : normalizeResolvedSecretInputString({
          value: accountConfig.botToken,
          path: `channels.zalo.accounts.${resolvedAccountId}.botToken`,
        });
    if (token) {
      return { token, source: "config" };
    }
    const fileToken = readTokenFromFile(accountConfig.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (!accountHasBotToken) {
    const fileToken = readTokenFromFile(accountConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (!accountHasBotToken) {
    const token = options?.allowUnresolvedSecretRef
      ? normalizeSecretInputString(baseConfig?.botToken)
      : normalizeResolvedSecretInputString({
          value: baseConfig?.botToken,
          path: "channels.zalo.botToken",
        });
    if (token) {
      return { token, source: "config" };
    }
    const fileToken = readTokenFromFile(baseConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (isDefaultAccount) {
    const envToken = process.env.ZALO_BOT_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}
