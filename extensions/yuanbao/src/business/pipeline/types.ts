/**
 * Message processing pipeline type definitions
 *
 * 定义中间件管线的核心类型，包括管线上下文、中间件函数签名和Description符。
 */

import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ModuleLog } from "../../logger.js";
import type { QuoteInfo, YuanbaoInboundMessage, ResolvedYuanbaoAccount } from "../../types.js";
import type { MediaItem, MentionItem } from "../messaging/handlers/types.js";
import type { QueueSession } from "../outbound/queue.js";
import type { MessageSender } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";
// import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

// ============ 防抖器项 ============

/** 防抖器 enqueue 的消息项 */
export interface DebouncerItem {
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  wsClient: YuanbaoWsClient;
  log?:
    | ModuleLog
    | {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
        verbose?: (msg: string) => void;
      };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  abortSignal?: AbortSignal;
}

// ============ 管线上下文 ============

/** Message processing context —— 在管线中流转，每个中间件可读写 */
export interface PipelineContext {
  // ---- 不可变输入 ----
  readonly raw: YuanbaoInboundMessage;
  readonly flushedItems: DebouncerItem[];
  readonly isGroup: boolean;
  readonly account: ResolvedYuanbaoAccount;
  readonly config: OpenClawConfig;
  readonly core: PluginRuntime;
  readonly wsClient: YuanbaoWsClient;
  readonly log: ModuleLog;
  readonly abortSignal?: AbortSignal;
  readonly statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;

  // ---- 可变中间状态（由各中间件逐步填充） ----

  /** extractContent 填充 */
  fromAccount: string;
  senderNickname?: string;
  groupCode?: string;
  rawBody: string;
  medias: MediaItem[];
  isAtBot: boolean;
  mentions: MentionItem[];

  /** resolveQuote 填充 */
  quoteInfo?: QuoteInfo;

  /** guardCommand 填充 */
  commandAuthorized: boolean;
  rewrittenBody: string;
  hasControlCommand: boolean;

  /** resolveMention 填充 */
  effectiveWasMentioned: boolean;

  /** downloadMedia 填充 */
  mediaPaths: string[];
  mediaTypes: string[];

  /** resolveRoute 填充 */
  route?: {
    agentId: string;
    sessionKey: string;
    accountId: string;
  };
  storePath?: string;
  envelopeOptions?: EnvelopeFormatOptions;
  previousTimestamp?: number;

  /** resolveTrace 填充 —— Trace context */
  traceContext?: YuanbaoTraceContext;

  /** buildContext 填充 */
  ctxPayload?: FinalizedMsgContext;

  /** prepareSender 填充 —— 消息发送器 */
  sender?: MessageSender;

  /** prepareSender 填充 —— 出站队列会话 */
  queueSession?: QueueSession;

  // ---- Action 请求（由 actions 适配层注入） ----

  /** action 名称（如 'sticker'、'sticker-search'、'react'），非 action 请求时为 undefined */
  action?: string;
}

// ============ 中间件 ============

/** 中间件函数签名（洋葱模型） */
export type Middleware = (ctx: PipelineContext, next: () => Promise<void>) => Promise<void>;

/** 中间件Description符 */
export interface MiddlewareDescriptor {
  /** 中间件名称（用于日志和调试） */
  name: string;
  /** 中间件处理函数 */
  handler: Middleware;
  /** 条件守卫：返回 false 时跳过该中间件 */
  when?: (ctx: PipelineContext) => boolean;
}
