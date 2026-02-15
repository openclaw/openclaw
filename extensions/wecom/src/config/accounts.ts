/**
 * WeCom 账号解析与模式检测
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  WecomConfig,
  WecomBotConfig,
  WecomAgentConfig,
  WecomNetworkConfig,
  ResolvedBotAccount,
  ResolvedAgentAccount,
  ResolvedMode,
  ResolvedWecomAccounts,
} from "../types/index.js";

const DEFAULT_ACCOUNT_ID = "default";

/**
 * 检测配置中启用的模式
 */
export function detectMode(config: WecomConfig | undefined): ResolvedMode {
  if (!config) return { bot: false, agent: false };

  const botConfigured = Boolean(config.bot?.token && config.bot?.encodingAESKey);
  const agentConfigured = Boolean(
    config.agent?.corpId &&
    config.agent?.corpSecret &&
    config.agent?.agentId &&
    config.agent?.token &&
    config.agent?.encodingAESKey,
  );

  return { bot: botConfigured, agent: agentConfigured };
}

/**
 * 解析 Bot 模式账号
 */
function resolveBotAccount(config: WecomBotConfig): ResolvedBotAccount {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: true,
    configured: Boolean(config.token && config.encodingAESKey),
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    receiveId: config.receiveId?.trim() ?? "",
    config,
  };
}

/**
 * 解析 Agent 模式账号
 */
function resolveAgentAccount(
  config: WecomAgentConfig,
  network?: WecomNetworkConfig,
): ResolvedAgentAccount {
  const agentIdRaw = config.agentId;
  const agentId = typeof agentIdRaw === "number" ? agentIdRaw : Number(agentIdRaw);

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: true,
    configured: Boolean(
      config.corpId && config.corpSecret && agentId && config.token && config.encodingAESKey,
    ),
    corpId: config.corpId,
    corpSecret: config.corpSecret,
    agentId,
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    config,
    network,
  };
}

/**
 * 解析 WeCom 账号 (双模式)
 */
export function resolveWecomAccounts(cfg: OpenClawConfig): ResolvedWecomAccounts {
  const wecom = cfg.channels?.wecom as WecomConfig | undefined;

  if (!wecom || wecom.enabled === false) {
    return {};
  }

  const mode = detectMode(wecom);

  return {
    bot:
      mode.bot && wecom.bot
        ? { ...resolveBotAccount(wecom.bot), network: wecom.network }
        : undefined,
    agent: mode.agent && wecom.agent ? resolveAgentAccount(wecom.agent, wecom.network) : undefined,
  };
}

/**
 * 检查是否有任何模式启用
 */
export function isWecomEnabled(cfg: OpenClawConfig): boolean {
  const accounts = resolveWecomAccounts(cfg);
  return Boolean(accounts.bot?.configured || accounts.agent?.configured);
}
