import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
import type { VkAccountConfig, VkConfig } from "./types.js";

export type VkTokenResolution = {
  token: string;
  source: "env" | "config" | "configFile" | "none";
};

function readTokenFromFile(tokenFile: string | undefined): string {
  return tryReadSecretFileSync(tokenFile, "VK token file", { rejectSymlink: true }) ?? "";
}

function getAccountConfig(
  config: VkConfig | undefined,
  accountId: string,
): Partial<VkAccountConfig> | undefined {
  return config?.accounts?.[normalizeAccountId(accountId)];
}

export function resolveVkToken(
  config: VkConfig | undefined,
  accountId?: string | null,
  options?: { allowUnresolvedSecretRef?: boolean },
): VkTokenResolution {
  const resolvedAccountId = normalizeAccountId(accountId);
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig = getAccountConfig(baseConfig, resolvedAccountId);
  const accountHasBotToken =
    Boolean(accountConfig) && Object.prototype.hasOwnProperty.call(accountConfig, "botToken");

  if (accountConfig && accountHasBotToken) {
    const token = options?.allowUnresolvedSecretRef
      ? normalizeSecretInputString(accountConfig.botToken)
      : normalizeResolvedSecretInputString({
          value: accountConfig.botToken,
          path: `channels.vk.accounts.${resolvedAccountId}.botToken`,
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
          path: "channels.vk.botToken",
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
    const envToken = process.env.VK_GROUP_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}
