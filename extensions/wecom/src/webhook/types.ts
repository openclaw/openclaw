/**
 * Webhook 模式专用类型定义
 *
 * 从 @mocrane/wecom monitor/types.ts 完整迁移，适配目标项目类型体系。
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WeComConfig, ResolvedWeComAccount } from "../utils.js";

// ============================================================================
// 常量
// ============================================================================

/** StreamState 过期时间 (10 分钟) */
export const STREAM_TTL_MS = 10 * 60 * 1000;

/** ActiveReply 过期时间 (1 小时) */
export const ACTIVE_REPLY_TTL_MS = 60 * 60 * 1000;

/** 消息防抖间隔 (500ms) */
export const DEFAULT_DEBOUNCE_MS = 500;

/** stream 回复最大字节数 (20KB) */
export const STREAM_MAX_BYTES = 20_480;

/** 企微 Bot 回复窗口 (6 分钟) */
export const BOT_WINDOW_MS = 6 * 60 * 1000;

/** 超时安全边际 (30 秒) */
export const BOT_SWITCH_MARGIN_MS = 30_000;

/** HTTP 请求超时 (15 秒) */
export const REQUEST_TIMEOUT_MS = 15_000;

/** 自动清理间隔 (60 秒) */
export const PRUNE_INTERVAL_MS = 60_000;

/** 固定 Webhook 路径 */
export const WEBHOOK_PATHS = {
  /** Bot 模式历史兼容路径 */
  BOT: "/wecom",
  /** Bot 模式历史备用兼容路径 */
  BOT_ALT: "/wecom/bot",
  /** Bot 模式推荐路径前缀 */
  BOT_PLUGIN: "/plugins/wecom/bot",
} as const;

// ============================================================================
// Webhook 配置扩展
// ============================================================================

/**
 * Webhook 模式下的额外账号配置字段
 */
export interface WebhookAccountConfig {
  /** 连接模式：webhook | websocket（默认 websocket） */
  connectionMode?: "webhook" | "websocket";
  /** Webhook 验证 token */
  token?: string;
  /** AES 加密密钥（43 字符 Base64） */
  encodingAESKey?: string;
  /** 接收方 ID */
  receiveId?: string;
  /** enter_chat 欢迎消息 */
  welcomeText?: string;
}

/**
 * 解析后的 Webhook 账号信息
 * 在 ResolvedWeComAccount 基础上增加 Webhook 专用字段
 */
export interface ResolvedWebhookAccount extends ResolvedWeComAccount {
  connectionMode: "webhook";
  token: string;
  encodingAESKey: string;
  receiveId: string;
  welcomeText?: string;
}

// ============================================================================
// 运行时环境
// ============================================================================

/**
 * Webhook 运行时环境
 *
 * 包含基础的日志和错误报告接口，用于解耦对 PluginRuntime 的直接依赖。
 */
export interface WecomRuntimeEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// ============================================================================
// Webhook Target
// ============================================================================

/**
 * Webhook 目标上下文
 *
 * 描述一个注册的 Bot 接收端点。包含处理该端点所需的所有上下文信息。
 */
export interface WecomWebhookTarget {
  /** 解析后的 Bot 账号信息 (Token, AESKey 等) */
  account: ResolvedWebhookAccount;
  /** 插件全局配置 */
  config: OpenClawConfig;
  /** 运行时环境 (日志) */
  runtime: WecomRuntimeEnv;
  /** OpenClaw 插件核心运行时 */
  core: PluginRuntime;
  /** 该 Target 注册的 Webhook 路径 */
  path: string;
  /** 反馈最后接收/发送时间 */
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

// ============================================================================
// 流式会话状态
// ============================================================================

/**
 * 流式会话状态
 *
 * 记录一个流式请求的生命周期状态。
 */
export interface StreamState {
  /** 唯一会话 ID */
  streamId: string;
  /** 关联的企业微信消息 ID（用于去重） */
  msgid?: string;
  /** 会话键（同一人同一会话，用于队列/批次） */
  conversationKey?: string;
  /** 批次键（conversationKey + 批次序号） */
  batchKey?: string;
  /** 触发者 userid（用于 Agent 私信兜底） */
  userId?: string;
  /** 会话类型（用于群聊兜底逻辑） */
  chatType?: "group" | "direct";
  /** 群聊 chatid（用于日志/提示，不用于 Agent 发群） */
  chatId?: string;
  /** 智能机器人 aibotid（用于 taskKey 生成与日志） */
  aibotid?: string;
  /** Bot 回调幂等键（用于最终交付幂等） */
  taskKey?: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间（用于 Prune） */
  updatedAt: number;
  /** 是否已开始处理（Agent 已介入） */
  started: boolean;
  /** 是否已完成（Agent 输出完毕或出错） */
  finished: boolean;
  /** 错误信息 */
  error?: string;
  /** 已积累的响应内容（用于长轮询返回） */
  content: string;
  /** 过程中生成的图片（Base64 + MD5） */
  images?: Array<{ base64: string; md5: string }>;
  /** 兜底模式（仅作为内部状态，不暴露给企微） */
  fallbackMode?: "media" | "timeout" | "error";
  /** 群内兜底提示是否已发送（用于防重复刷屏） */
  fallbackPromptSentAt?: number;
  /** Agent 私信最终交付是否已完成（用于防重复发送） */
  finalDeliveredAt?: number;
  /** 用于私信兜底的完整内容（不受 STREAM_MAX_BYTES 限制，但仍需上限保护） */
  dmContent?: string;
  /** 已通过 Agent 私信发送过的媒体标识（防重复发送附件） */
  agentMediaKeys?: string[];
  /** 是否来自 WebSocket 长链接模式（用于跳过 6 分钟超时等 webhook 特有逻辑） */
  wsMode?: boolean;
}

// ============================================================================
// 防抖待处理消息
// ============================================================================

/**
 * Webhook 入站消息（解密后的 JSON 格式）
 *
 * 字段命名对齐企微 Bot 回调的实际 JSON 结构（与原版 WecomBotInboundBase 一致）：
 * - 发送者：`from.userid`（非 from.user_id）
 * - 会话类型：`chattype`（扁平字段，非 chat_info.chat_type）
 * - 群聊 ID：`chatid`（扁平字段，非 chat_info.chat_id）
 * - 事件类型：`event.eventtype`（非 event.event_type）
 * - 流 ID：`stream.id`（非 stream.stream_id）
 */
export interface WebhookInboundMessage {
  msgtype: string;
  msgid?: string;
  /** 企微 Bot 回调中的机器人 ID */
  aibotid?: string;
  /** 会话类型：single | group（扁平字段） */
  chattype?: "single" | "group";
  /** 群聊 ID（扁平字段，仅群组时存在） */
  chatid?: string;
  /** 附件数量 */
  attachment_count?: number;

  text?: { content?: string };
  image?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string; base64?: string; md5?: string };
  file?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string; filename?: string; file_name?: string; fileName?: string };
  voice?: { content?: string; url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string };
  video?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string };
  mixed?: {
    msg_item: Array<{
      msgtype: string;
      text?: { content?: string };
      image?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string; base64?: string; md5?: string };
      file?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string; filename?: string };
      [key: string]: unknown;
    }>;
  };
  /** 引用消息 */
  quote?: WebhookInboundQuote;

  /** 发送者（企微 Bot 回调中 userid 是 from.userid） */
  from?: { userid?: string; corpid?: string };
  /** 事件（eventtype 非 event_type） */
  event?: { eventtype?: string; event_key?: string; template_card_event?: Record<string, unknown>; [key: string]: unknown };
  /** 流式消息 */
  stream?: { id?: string };
  /** 下行回复 URL */
  response_url?: string;
}

/**
 * 引用消息结构（对齐原版 WecomInboundQuote）
 */
export interface WebhookInboundQuote {
  msgtype?: "text" | "image" | "mixed" | "voice" | "file" | "video";
  text?: { content?: string };
  image?: { url?: string };
  mixed?: {
    msg_item?: Array<{
      msgtype: "text" | "image";
      text?: { content?: string };
      image?: { url?: string };
    }>;
  };
  voice?: { content?: string };
  file?: { url?: string };
  video?: { url?: string };
}

/**
 * 待处理/防抖消息
 *
 * 暂存在队列中的消息，等待防抖计时器结束进行聚合。
 */
export interface PendingInbound {
  /** 预分配的流 ID */
  streamId: string;
  /** 会话标识 */
  conversationKey: string;
  /** 批次键 */
  batchKey: string;
  /** 目标 Webhook 上下文 */
  target: WecomWebhookTarget;
  /** 原始消息对象（如果聚合，通常指第一条） */
  msg: WebhookInboundMessage;
  /** 聚合的消息内容列表 */
  contents: string[];
  /** 附带的媒体文件（如果有） */
  media?: { buffer: Buffer; contentType: string; filename: string };
  /** 聚合的所有消息 ID（用于去重） */
  msgids: string[];
  /** 回调 nonce */
  nonce: string;
  /** 回调 timestamp */
  timestamp: string;
  /** 防抖定时器句柄 */
  timeout: ReturnType<typeof setTimeout> | null;
  /** 已到达防抖截止时间，但因前序批次仍在处理中而暂存 */
  readyToFlush?: boolean;
  /** 创建时间 */
  createdAt: number;
}

// ============================================================================
// 主动回复地址状态
// ============================================================================

/**
 * 主动回复地址状态
 *
 * 存储企业微信回调中提供的 response_url，用于后续主动推送。
 */
export interface ActiveReplyState {
  /** 企业微信提供的回调回复 URL */
  response_url: string;
  /** 如果配置了代理，存储代理地址 */
  proxyUrl?: string;
  /** 创建时间 */
  createdAt: number;
  /** 使用时间（仅当 policy="once" 时有意义） */
  usedAt?: number;
  /** 最后一次发送失败的错误信息 */
  lastError?: string;
}

// ============================================================================
// Gateway 上下文
// ============================================================================

/**
 * Webhook Gateway 上下文
 */
export interface WebhookGatewayContext {
  account: ResolvedWebhookAccount;
  config: OpenClawConfig;
  /** RuntimeEnv 日志环境 (来自 ChannelGatewayContext.runtime) */
  runtime: RuntimeEnv;
  /** PluginRuntime 用于访问 channel.reply 等核心功能 */
  channelRuntime?: PluginRuntime;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
  accountId: string;
}
