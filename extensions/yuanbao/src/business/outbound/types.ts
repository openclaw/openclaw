/**
 * Send module type definitions
 *
 * Define core types for outbound messages: message items, send results, send targets, and sender interface.
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

// ============ 出站消息项 ============

/** 出站消息项 */
export type OutboundItem =
  | { type: "text"; text: string }
  | { type: "media"; mediaUrl: string; fallbackText?: string }
  | { type: "sticker"; stickerId: string }
  | { type: "raw"; msgBody: YuanbaoMsgBodyElement[] };

// ============ 发送结果 ============

/** 发送结果 */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// ============ 发送目标上下文 ============

/** 发送目标上下文 —— 由 prepareSender 中间件组装 */
export interface SendParams {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C 为 toAccount，群聊为 groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  config: OpenClawConfig;
  core: PluginRuntime;
  /** Trace context，透传给 transport 层注入 trace_id / msg_seq */
  traceContext?: YuanbaoTraceContext;
}

// ============ 消息发送器接口 ============

/** 消息发送器接口 */
export interface MessageSender {
  sendText(text: string): Promise<SendResult>;
  sendMedia(mediaUrl: string, fallbackText?: string): Promise<SendResult>;
  sendSticker(stickerId: string): Promise<SendResult>;
  sendRaw(msgBody: YuanbaoMsgBodyElement[]): Promise<SendResult>;
  /** 根据 OutboundItem 类型自动分发 */
  send(item: OutboundItem): Promise<SendResult>;
  /** 从 SDK OutboundReplyPayload 自动分发（配合 dispatchInboundReplyWithBase 的 deliver 回调） */
  deliver(payload: OutboundReplyPayload): Promise<void>;
}
