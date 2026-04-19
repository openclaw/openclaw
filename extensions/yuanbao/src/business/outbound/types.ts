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

/** Outbound message item */
export type OutboundItem =
  | { type: "text"; text: string }
  | { type: "media"; mediaUrl: string; fallbackText?: string }
  | { type: "sticker"; stickerId: string }
  | { type: "raw"; msgBody: YuanbaoMsgBodyElement[] };

/** Send result */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** Send target context — assembled by prepareSender middleware */
export interface SendParams {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C: toAccount; group chat: groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  config: OpenClawConfig;
  core: PluginRuntime;
  /** Trace context, passed through to transport layer for injecting trace_id / msg_seq */
  traceContext?: YuanbaoTraceContext;
}

/** Message sender interface */
export interface MessageSender {
  sendText(text: string): Promise<SendResult>;
  sendMedia(mediaUrl: string, fallbackText?: string): Promise<SendResult>;
  sendSticker(stickerId: string): Promise<SendResult>;
  sendRaw(msgBody: YuanbaoMsgBodyElement[]): Promise<SendResult>;
  /** Auto-dispatch based on OutboundItem type */
  send(item: OutboundItem): Promise<SendResult>;
  /** Auto-dispatch from SDK OutboundReplyPayload (used with dispatchInboundReplyWithBase deliver callback) */
  deliver(payload: OutboundReplyPayload): Promise<void>;
}
