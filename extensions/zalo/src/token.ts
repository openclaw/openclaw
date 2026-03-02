import { readFileSync } from "node:fs";
import { type BaseTokenResolution, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
import type { ZaloConfig } from "./types.js";

export type ZaloTokenResolution = BaseTokenResolution & {
  source: "env" | "config" | "configFile" | "none";
};

export function resolveZaloToken(
  config: ZaloConfig | undefined,
  accountId?: string | null,
): ZaloTokenResolution {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig =
    resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? (baseConfig?.accounts?.[resolvedAccountId] as ZaloConfig | undefined)
      : undefined;

  if (accountConfig) {
    const token = normalizeResolvedSecretInputString({
      value: accountConfig.botToken,
      path: `channels.zalo.accounts.${resolvedAccountId}.botToken`,
    });
    if (token) {
      return { token, source: "config" };
    }
    const tokenFile = accountConfig.tokenFile?.trim();
    if (tokenFile) {
      try {
        const fileToken = readFileSync(tokenFile, "utf8").trim();
        if (fileToken) {
          return { token: fileToken, source: "configFile" };
        }
      } catch {
        // ignore read failures
      }
    }
  }

  if (isDefaultAccount) {
    const token = normalizeResolvedSecretInputString({
      value: baseConfig?.botToken,
      path: "channels.zalo.botToken",
    });
    if (token) {
      return { token, source: "config" };
    }
    const tokenFile = baseConfig?.tokenFile?.trim();
    if (tokenFile) {
      try {
        const fileToken = readFileSync(tokenFile, "utf8").trim();
        if (fileToken) {
          return { token: fileToken, source: "configFile" };
        }
      } catch {
        // ignore read failures
      }
    }
    const envToken = process.env.ZALO_BOT_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}
