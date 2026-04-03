/**
 * WeCom 子模块配置类型定义
 *
 * 注意：顶层配置类型 WeComConfig 定义在 src/utils.ts 中，以平铺结构为准。
 * 本文件仅定义 Agent/Bot/DM/Network/Media 等子模块的配置类型。
 */

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
    /** 智能机器人 ID（用于 Matrix 模式二次身份确认，webhook 模式） */
    aibotid?: string;
    /** 回调 Token (企微后台生成，webhook 模式必填) */
    token?: string;
    /** 回调加密密钥 (企微后台生成，webhook 模式必填) */
    encodingAESKey?: string;
    /**
     * BotId 列表（可选，用于审计与告警）。
     * - 回调路由优先由 URL + 签名决定；botIds 不参与强制拦截。
     * - 当解密后的 aibotid 不在 botIds 中时，仅记录告警日志。
     */
    botIds?: string[];
    /** 接收者 ID (可选，用于解密校验) */
    receiveId?: string;
    /** 流式消息占位符 */
    streamPlaceholderContent?: string;
    /** 欢迎语 */
    welcomeText?: string;
    /** DM 策略: 'open' 允许所有人, 'pairing' 需要配对, 'allowlist' 仅允许列表, 'disabled' 禁用 */
    dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
    /** 允许的用户列表，为空表示允许所有人 */
    allowFrom?: Array<string | number>;

    // --- 长链接模式 (WebSocket) ---

    /** 连接模式：webhook（默认）或 websocket */
    connectionMode?: 'webhook' | 'websocket';
    /** 机器人 BotID（websocket 模式必填，企微后台获取） */
    botId?: string;
    /** 机器人 Secret（websocket 模式必填，企微后台获取） */
    secret?: string;
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
    /** 应用 ID（可选；不填时可接收回调，但主动发送需具备该字段） */
    agentId?: number | string;
    /** 回调 Token (企微后台「设置API接收」) */
    token: string;
    /** 回调加密密钥 (企微后台「设置API接收」) */
    encodingAESKey: string;
    /** 欢迎语 */
    welcomeText?: string;
    /** DM 策略: 'open' 允许所有人, 'pairing' 需要配对, 'allowlist' 仅允许列表, 'disabled' 禁用 */
    dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
    /** 允许的用户列表，为空表示允许所有人 */
    allowFrom?: Array<string | number>;
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
