/**
 * QQBot 配置解析（纯逻辑层）。
 *
 * Resolves account IDs, default account selection, and base account
 * info from raw config objects. Secret/credential resolution is
 * intentionally left to the outer layer (src/config.ts) so that
 * this module stays framework-agnostic and self-contained.
 */

import {
  asOptionalObjectRecord as asRecord,
  normalizeOptionalLowercaseString,
  readStringField as readString,
} from "../utils/string-normalize.js";

/** 默认账号 ID，用于顶层配置中未命名的账号。 */
export const DEFAULT_ACCOUNT_ID = "default";

/** channels.qqbot 配置节的内部结构。 */
interface QQBotChannelConfig {
  appId?: unknown;
  clientSecret?: unknown;
  clientSecretFile?: string;
  accounts?: Record<string, Record<string, unknown>>;
  defaultAccount?: unknown;
  [key: string]: unknown;
}

/**
 * 账号基础解析结果（不含凭证信息）。
 *
 * The outer config.ts layer extends this with clientSecret / secretSource.
 */
export interface ResolvedAccountBase {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  systemPrompt?: string;
  markdownSupport: boolean;
  config: Record<string, unknown>;
}

function normalizeAppId(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  return "";
}

function normalizeAccountConfig(
  account: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!account) {
    return {};
  }
  const audioPolicy = asRecord(account.audioFormatPolicy);
  return {
    ...account,
    ...(audioPolicy ? { audioFormatPolicy: { ...audioPolicy } } : {}),
  };
}

function readQQBotSection(cfg: Record<string, unknown>): QQBotChannelConfig | undefined {
  const channels = asRecord(cfg.channels);
  return asRecord(channels?.qqbot) as QQBotChannelConfig | undefined;
}

/** 列出所有已配置的 QQBot 账号 ID。 */
export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const qqbot = readQQBotSection(cfg);

  if (qqbot?.appId || process.env.QQBOT_APP_ID) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/** 解析默认 QQBot 账号 ID（优先级：defaultAccount 配置 > 顶层 appId > 第一个命名账号）。 */
export function resolveDefaultAccountId(cfg: Record<string, unknown>): string {
  const qqbot = readQQBotSection(cfg);
  const configuredDefaultAccountId = normalizeOptionalLowercaseString(qqbot?.defaultAccount);
  if (
    configuredDefaultAccountId &&
    (configuredDefaultAccountId === DEFAULT_ACCOUNT_ID ||
      Boolean(qqbot?.accounts?.[configuredDefaultAccountId]?.appId))
  ) {
    return configuredDefaultAccountId;
  }
  if (qqbot?.appId || process.env.QQBOT_APP_ID) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析账号基础信息（不含凭证）。
 *
 * Resolves everything except Secret/credential fields. The outer
 * config.ts layer calls this and adds Secret handling on top.
 */
export function resolveAccountBase(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedAccountBase {
  const resolvedAccountId = accountId ?? resolveDefaultAccountId(cfg);
  const qqbot = readQQBotSection(cfg);

  let accountConfig: Record<string, unknown> = {};
  let appId = "";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    accountConfig = normalizeAccountConfig(asRecord(qqbot));
    appId = normalizeAppId(qqbot?.appId);
  } else {
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = normalizeAccountConfig(asRecord(account));
    appId = normalizeAppId(asRecord(account)?.appId);
  }

  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: readString(accountConfig, "name"),
    enabled: accountConfig.enabled !== false,
    appId,
    systemPrompt: readString(accountConfig, "systemPrompt"),
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}
