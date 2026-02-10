/**
 * WeCom 账号类型定义
 */

import type { WecomBotConfig, WecomAgentConfig, WecomDmConfig, WecomNetworkConfig } from "./config.js";

/**
 * 解析后的 Bot 账号
 */
export type ResolvedBotAccount = {
    /** 账号 ID */
    accountId: string;
    /** 是否启用 */
    enabled: boolean;
    /** 是否配置完整 */
    configured: boolean;
    /** 回调 Token */
    token: string;
    /** 回调加密密钥 */
    encodingAESKey: string;
    /** 接收者 ID */
    receiveId: string;
    /** 原始配置 */
    config: WecomBotConfig;
    /** 网络配置（来自 channels.wecom.network） */
    network?: WecomNetworkConfig;
};

/**
 * 解析后的 Agent 账号
 */
export type ResolvedAgentAccount = {
    /** 账号 ID */
    accountId: string;
    /** 是否启用 */
    enabled: boolean;
    /** 是否配置完整 */
    configured: boolean;
    /** 企业 ID */
    corpId: string;
    /** 应用 Secret */
    corpSecret: string;
    /** 应用 ID (数字) */
    agentId: number;
    /** 回调 Token */
    token: string;
    /** 回调加密密钥 */
    encodingAESKey: string;
    /** 原始配置 */
    config: WecomAgentConfig;
    /** 网络配置（来自 channels.wecom.network） */
    network?: WecomNetworkConfig;
};

/**
 * 已解析的模式状态
 */
export type ResolvedMode = {
    /** Bot 模式是否已配置 */
    bot: boolean;
    /** Agent 模式是否已配置 */
    agent: boolean;
};

/**
 * 解析后的 WeCom 账号集合
 */
export type ResolvedWecomAccounts = {
    /** Bot 模式账号 */
    bot?: ResolvedBotAccount;
    /** Agent 模式账号 */
    agent?: ResolvedAgentAccount;
};

// Re-export 用于向后兼容
export type { WecomDmConfig } from "./config.js";
