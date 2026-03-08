/**
 * 企业微信消息发送模块
 *
 * 负责通过 WSClient 发送回复消息，包含超时保护
 */

import { type WSClient, type WsFrame, generateReqId } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { REPLY_SEND_TIMEOUT_MS } from "./const.ts";
import { withTimeout } from "./timeout.ts";

// ============================================================================
// 消息发送
// ============================================================================

/**
 * 发送企业微信回复消息
 * 供 monitor 内部和 channel outbound 使用
 *
 * @returns messageId (streamId)
 */
export async function sendWeComReply(params: {
  wsClient: WSClient;
  frame: WsFrame;
  text?: string;
  runtime: RuntimeEnv;
  /** 是否为流式回复的最终消息，默认为 true */
  finish?: boolean;
  /** 指定 streamId，用于流式回复时保持相同的 streamId */
  streamId?: string;
}): Promise<string> {
  const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;

  if (!text) {
    return "";
  }

  const streamId = existingStreamId || generateReqId("stream");

  if (!wsClient.isConnected) {
    runtime.error?.(`[WeCom] WSClient not connected, cannot send reply`);
    throw new Error("WSClient not connected");
  }

  // 使用 SDK 的 replyStream 方法发送消息，带超时保护
  await withTimeout(
    wsClient.replyStream(frame, streamId, text, finish),
    REPLY_SEND_TIMEOUT_MS,
    `Reply send timed out (streamId=${streamId})`,
  );
  runtime.log?.(`[WeCom] Sent reply: streamId=${streamId}, finish=${finish}`);

  return streamId;
}
