import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk";
import { PLUGIN_ID } from "./constants.js";
import type { DingTalkConfig, ResolvedDingTalkAccount } from "./types.js";

/**
 * 规范化账户 ID（始终返回默认账户 ID）
 */
export function normalizeAccountId(_accountId?: string | null): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 列出所有钉钉账户 ID（单账户，只返回默认账户）
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;
  if (!dingtalkConfig?.clientId) {
    return [];
  }
  return [DEFAULT_ACCOUNT_ID];
}

/**
 * 解析默认钉钉账户 ID
 */
export function resolveDefaultDingTalkAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析钉钉账户配置（单账户模式）
 */
export function resolveDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDingTalkAccount {
  const { cfg } = params;
  const dingtalkConfig = cfg.channels?.[PLUGIN_ID] as DingTalkConfig | undefined;

  // 默认返回值
  const defaultResult: ResolvedDingTalkAccount = {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: false,
    clientId: "",
    clientSecret: "",
    tokenSource: "none",
    allowFrom: ["*"],
  };

  if (!dingtalkConfig) {
    return defaultResult;
  }

  let clientId = "";
  let clientSecret = "";
  let tokenSource: ResolvedDingTalkAccount["tokenSource"] = "none";

  if (dingtalkConfig.clientId?.trim()) {
    clientId = dingtalkConfig.clientId.trim();
    tokenSource = "config";
  }

  if (dingtalkConfig.clientSecret?.trim()) {
    clientSecret = dingtalkConfig.clientSecret.trim();
  }

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: dingtalkConfig.name,
    enabled: dingtalkConfig.enabled ?? true,
    clientId,
    clientSecret,
    tokenSource,
    allowFrom: dingtalkConfig.allowFrom ?? ["*"],
  };
}
