/**
 * 企业微信渠道常量定义
 */

/**
 * 企业微信渠道 ID
 */
export const CHANNEL_ID = "wecom" as const;

/**
 * 企业微信 WebSocket 命令枚举
 */
export enum WeComCommand {
  /** 认证订阅 */
  SUBSCRIBE = "aibot_subscribe",
  /** 心跳 */
  PING = "ping",
  /** 企业微信推送消息 */
  AIBOT_CALLBACK = "aibot_callback",
  /** clawdbot 响应消息 */
  AIBOT_RESPONSE = "aibot_response",
}

// ============================================================================
// 超时和重试配置
// ============================================================================

/** 图片下载超时时间（毫秒） */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** 文件下载超时时间（毫秒） */
export const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** 消息发送超时时间（毫秒） */
export const REPLY_SEND_TIMEOUT_MS = 15_000;

/** 消息处理总超时时间（毫秒） */
export const MESSAGE_PROCESS_TIMEOUT_MS = 6 * 60 * 1000;

/** WebSocket 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** WebSocket 连接断开时的最大重连次数 */
export const WS_MAX_RECONNECT_ATTEMPTS = 10;

/** WebSocket 认证失败时的最大重试次数 */
export const WS_MAX_AUTH_FAILURE_ATTEMPTS = 5;

// ============================================================================
// 消息状态管理配置
// ============================================================================

/** messageStates Map 条目的最大 TTL（毫秒），防止内存泄漏 */
export const MESSAGE_STATE_TTL_MS = 10 * 60 * 1000;

/** messageStates Map 清理间隔（毫秒） */
export const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60_000;

/** messageStates Map 最大条目数 */
export const MESSAGE_STATE_MAX_SIZE = 500;

// ============================================================================
// 消息模板
// ============================================================================

/** "思考中"流式消息占位内容 */
export const THINKING_MESSAGE = "<think></think>";

/** 仅包含图片时的消息占位符 */
export const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";

/** 仅包含文件时的消息占位符 */
export const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
// ============================================================================
// 默认值
// ============================================================================

// ============================================================================
// MCP 配置
// ============================================================================

/** 获取 MCP 配置的 WebSocket 命令 */
export const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";

/** MCP 配置拉取超时时间（毫秒） */
export const MCP_CONFIG_FETCH_TIMEOUT_MS = 15_000;

// ============================================================================
// 默认值
// ============================================================================

/** 默认媒体大小上限（MB） */
export const DEFAULT_MEDIA_MAX_MB = 5;

/** 文本分块大小上限 */
export const TEXT_CHUNK_LIMIT = 4000;

// ============================================================================
// 媒体上传相关常量
// ============================================================================

/** 图片大小上限（字节）：10MB */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 视频大小上限（字节）：10MB */
export const VIDEO_MAX_BYTES = 10 * 1024 * 1024;

/** 语音大小上限（字节）：2MB */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/** 文件大小上限（字节）：20MB */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

/** 文件绝对上限（字节）：超过此值无法发送，等于 FILE_MAX_BYTES */
export const ABSOLUTE_MAX_BYTES = FILE_MAX_BYTES;

/** 上传分片大小（字节，Base64 编码前）：512KB */
export const UPLOAD_CHUNK_SIZE = 512 * 1024;

// ============================================================================
// 事件/命令名称常量
// ============================================================================

/** 版本检查事件名称（SDK 事件监听用） */
export const EVENT_ENTER_CHECK_UPDATE = "event.enter_check_update";

/** 版本检查事件回复命令名称 */
export const CMD_ENTER_EVENT_REPLY = "ww_ai_robot_enter_event";

// ============================================================================
// SDK 连接配置
// ============================================================================

/** WSClient scene 参数：企微 OpenClaw 场景 */
export const SCENE_WECOM_OPENCLAW = 1;
/**
 * WeCom 双模式常量定义
 */

/** 固定 Webhook 路径 */
export const WEBHOOK_PATHS = {
    /** Bot 模式历史兼容路径（不再维护） */
    BOT: "/wecom",
    /** Bot 模式历史备用兼容路径（不再维护） */
    BOT_ALT: "/wecom/bot",
    /** Agent 模式历史兼容路径（不再维护） */
    AGENT: "/wecom/agent",
    /** Bot 模式推荐路径前缀 */
    BOT_PLUGIN: "/plugins/wecom/bot",
    /** Agent 模式推荐路径前缀 */
    AGENT_PLUGIN: "/plugins/wecom/agent",
} as const;

/** 企业微信 API 端点 */
export const API_ENDPOINTS = {
    GET_TOKEN: "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    SEND_MESSAGE: "https://qyapi.weixin.qq.com/cgi-bin/message/send",
    SEND_APPCHAT: "https://qyapi.weixin.qq.com/cgi-bin/appchat/send",
    UPLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/upload",
    DOWNLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/get",
} as const;

/** 各类限制常量 */
export const LIMITS = {
    /** 文本消息最大字节数 */
    TEXT_MAX_BYTES: 2048,
    /** Token 刷新缓冲时间 (提前刷新) */
    TOKEN_REFRESH_BUFFER_MS: 60_000,
    /** HTTP 请求超时 */
    REQUEST_TIMEOUT_MS: 15_000,
    /** 最大请求体大小 */
    MAX_REQUEST_BODY_SIZE: 1024 * 1024,
} as const;

/** AES 加密常量 */
export const CRYPTO = {
    /** PKCS#7 块大小 */
    PKCS7_BLOCK_SIZE: 32,
    /** AES Key 长度 */
    AES_KEY_LENGTH: 32,
} as const;

// ============================================================================
// 模板卡片配置
// ============================================================================

/** 合法的模板卡片 card_type 列表 */
export const VALID_CARD_TYPES: string[] = [
  "text_notice",
  "news_notice",
  "button_interaction",
  "vote_interaction",
  "multiple_interaction",
];

/** 模板卡片缓存条目 TTL（毫秒）：24小时 */
export const TEMPLATE_CARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 模板卡片缓存最大条目数 */
export const TEMPLATE_CARD_CACHE_MAX_SIZE = 300;
