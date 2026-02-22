import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WecomInboundMessage } from "../types.js";
import type { ResolvedBotAccount } from "../types/index.js";

/**
 * **WecomRuntimeEnv (运行时环境)**
 *
 * 包含基础的日志和错误报告接口，用于解耦对 PluginRuntime 的直接依赖。
 */
export type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * **WecomWebhookTarget (Webhook 目标上下文)**
 *
 * 描述一个注册的 Bot 接收端点。包含处理该端点所需的所有上下文信息。
 *
 * @property account 解析后的 Bot 账号信息 (Token, AESKey 等)
 * @property config 插件全局配置
 * @property runtime 运行时环境 (日志)
 * @property core OpenClaw 插件核心运行时
 * @property path 该 Target 注册的 Webhook 路径
 * @property statusSink 用于上报最后收发消息时间的回调
 */
export type WecomWebhookTarget = {
  account: ResolvedBotAccount;
  config: OpenClawConfig;
  runtime: WecomRuntimeEnv;
  core: PluginRuntime;
  path: string;
  /** 反馈最后接收/发送时间 */
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

/**
 * **StreamState (流式会话状态)**
 *
 * 记录一个流式请求的生命周期状态。
 *
 * @property streamId 唯一会话 ID
 * @property msgid 关联的企业微信消息 ID (用于去重)
 * @property createdAt 创建时间
 * @property updatedAt 最后更新时间 (用于 Prune)
 * @property started 是否已开始处理 (Agent 已介入)
 * @property finished 是否已完成 (Agent 输出完毕或出错)
 * @property error 错误信息 (如有)
 * @property content 已积累的响应内容 (用于长轮询返回)
 * @property images 过程中生成的图片 (Base64 + MD5)
 */
export type StreamState = {
  streamId: string;
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
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
  images?: { base64: string; md5: string }[];
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
};

/**
 * **PendingInbound (待处理/防抖消息)**
 *
 * 暂存在队列中的消息，等待防抖计时器结束进行聚合。
 *
 * @property streamId 预分配的流 ID
 * @property target 目标 Webhook 上下文
 * @property msg 原始消息对象 (如果聚合，通常指第一条)
 * @property contents 聚合的消息内容列表
 * @property media 附带的媒体文件 (如果有)
 * @property msgids 聚合的所有消息 ID (用于去重)
 * @property timeout 防抖定时器句柄
 */
export type PendingInbound = {
  streamId: string;
  conversationKey: string;
  batchKey: string;
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  contents: string[];
  media?: { buffer: Buffer; contentType: string; filename: string };
  msgids: string[];
  nonce: string;
  timestamp: string;
  timeout: ReturnType<typeof setTimeout> | null;
  /** 已到达防抖截止时间，但因前序批次仍在处理中而暂存 */
  readyToFlush?: boolean;
  createdAt: number;
};

/**
 * **ActiveReplyState (主动回复地址状态)**
 *
 * 存储企业微信回调中提供的 `response_url`，用于后续将流式响应转为主动推送(template_card)等。
 *
 * @property response_url 企业微信提供的回调回复 URL
 * @property proxyUrl 如果配置了代理，存储代理地址
 * @property createdAt 创建时间
 * @property usedAt 使用时间 (仅当 policy="once" 时有意义)
 * @property lastError 最后一次发送失败的错误信息
 */
export type ActiveReplyState = {
  response_url: string;
  proxyUrl?: string;
  createdAt: number;
  usedAt?: number;
  lastError?: string;
};
