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
export const MESSAGE_PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

/** WebSocket 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** WebSocket 最大重连次数 */
export const WS_MAX_RECONNECT_ATTEMPTS = 100;

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

/** 默认媒体大小上限（MB） */
export const DEFAULT_MEDIA_MAX_MB = 5;

/** 文本分块大小上限 */
export const TEXT_CHUNK_LIMIT = 4000;
