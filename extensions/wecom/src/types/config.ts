/**
 * WeCom 双模式配置类型定义
 */

/** DM 策略配置 - 与其他渠道保持一致，仅用 allowFrom */
export type WecomDmConfig = {
    /** DM 策略: 'open' 允许所有人, 'pairing' 需要配对, 'allowlist' 仅允许列表, 'disabled' 禁用 */
    policy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
    /** 允许的用户列表，为空表示允许所有人 */
    allowFrom?: Array<string | number>;
};

/** 媒体处理配置 */
export type WecomMediaConfig = {
    tempDir?: string;
    retentionHours?: number;
    cleanupOnStart?: boolean;
    maxBytes?: number;
};

/** 网络配置 */
export type WecomNetworkConfig = {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    /**
     * 出口代理（用于企业可信 IP 固定出口场景）。
     * 示例: "http://proxy.company.local:3128"
     */
    egressProxyUrl?: string;
};

/**
 * Bot 模式配置 (智能体)
 * 用于接收 JSON 格式回调 + 流式回复
 */
export type WecomBotConfig = {
    /** 回调 Token (企微后台生成) */
    token: string;
    /** 回调加密密钥 (企微后台生成) */
    encodingAESKey: string;
    /** 接收者 ID (可选，用于解密校验) */
    receiveId?: string;
    /** 流式消息占位符 */
    streamPlaceholderContent?: string;
    /** 欢迎语 */
    welcomeText?: string;
    /** DM 策略 */
    dm?: WecomDmConfig;
};

/**
 * Agent 模式配置 (自建应用)
 * 用于接收 XML 格式回调 + API 主动发送
 */
export type WecomAgentConfig = {
    /** 企业 ID */
    corpId: string;
    /** 应用 Secret */
    corpSecret: string;
    /** 应用 ID */
    agentId: number | string;
    /** 回调 Token (企微后台「设置API接收」) */
    token: string;
    /** 回调加密密钥 (企微后台「设置API接收」) */
    encodingAESKey: string;
    /** 欢迎语 */
    welcomeText?: string;
    /** DM 策略 */
    dm?: WecomDmConfig;
};

/** 动态 Agent 配置 */
export type WecomDynamicAgentsConfig = {
    /** 是否启用动态 Agent */
    enabled?: boolean;
    /** 私聊：是否为每个用户创建独立 Agent */
    dmCreateAgent?: boolean;
    /** 群聊：是否启用动态 Agent */
    groupEnabled?: boolean;
    /** 管理员列表（绕过动态路由，使用主 Agent） */
    adminUsers?: string[];
};

/**
 * 顶层 WeCom 配置
 * 通过 bot / agent 字段隐式指定模式
 */
export type WecomConfig = {
    /** 是否启用 */
    enabled?: boolean;
    /** Bot 模式配置 (智能体) */
    bot?: WecomBotConfig;
    /** Agent 模式配置 (自建应用) */
    agent?: WecomAgentConfig;
    /** 媒体处理配置 */
    media?: WecomMediaConfig;
    /** 网络配置 */
    network?: WecomNetworkConfig;
    /** 动态 Agent 配置 */
    dynamicAgents?: WecomDynamicAgentsConfig;
};
