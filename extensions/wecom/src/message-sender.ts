/**
 * WeCom message sending module
 *
 * Responsible for sending reply messages via WSClient, with timeout protection
 */

import { type WSClient, type WsFrame, generateReqId } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { REPLY_SEND_TIMEOUT_MS } from "./const.js";
import { withTimeout } from "./timeout.js";

// ============================================================================
// Stream expiration error (errcode 846608)
// ============================================================================

/** Stream reply timeout error code (>6 minutes without update, server refuses to continue stream updates) */
export const STREAM_EXPIRED_ERRCODE = 846608;

/**
 * Stream reply expiration error
 * Thrown when the server returns errcode=846608, indicating the stream message has been
 * inactive for over 6 minutes and can no longer be updated.
 * Callers need to fall back to proactive sending (sendMessage).
 */
export class StreamExpiredError extends Error {
  readonly errcode = STREAM_EXPIRED_ERRCODE;
  constructor(message?: string) {
    super(message ?? `Stream message update expired (errcode=${STREAM_EXPIRED_ERRCODE})`);
    this.name = "StreamExpiredError";
  }
}

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
  /** Whether this is the final message in a stream reply, defaults to true */
  finish?: boolean;
  /** Specify streamId, used to maintain the same streamId during stream replies */
  streamId?: string;
}): Promise<string> {
  const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;

  if (!text) {
    return "";
  }

  const streamId = existingStreamId || generateReqId("stream");

  if (!wsClient.isConnected) {
    runtime.error?.(`[wecom] WSClient not connected, cannot send reply`);
    throw new Error("WSClient not connected");
  }

  const body = frame.body as {
    msgtype?: string;
    chatid?: string;
    from?: {
      userid?: string;
    };
  };

  // 事件回调（aibot_event_callback）没有可用于 replyStream 的有效 req_id，
  // 对该场景改用主动发送 sendMessage，避免 846605 invalid req_id。
  if (body.msgtype === "event") {
    // 中间帧（thinking / 流式增量）直接跳过，仅在最终帧主动发一次文本。
    if (!finish) {
      runtime.log?.(
        `[plugin -> server] skip non-final stream for event callback, streamId=${streamId}`,
      );
      return streamId;
    }

    const chatId = body.chatid || body.from?.userid;
    if (!chatId) {
      throw new Error("Missing chatId for event callback reply");
    }

    await withTimeout(
      wsClient.sendMessage(chatId, {
        msgtype: "markdown",
        markdown: { content: text },
      }),
      REPLY_SEND_TIMEOUT_MS,
      `Event reply send timed out (streamId=${streamId})`,
    );
    runtime.log?.(`[plugin -> server] event-active-send chatId=${chatId}, finish=${finish}`);
    return streamId;
  }

  // Non-event messages: continue using replyStream (passive reply)
  // Use SDK's replyStream method to send messages, with timeout protection
  try {
    await withTimeout(
      wsClient.replyStream(frame, streamId, text, finish),
      REPLY_SEND_TIMEOUT_MS,
      `Reply send timed out (streamId=${streamId})`,
    );
  } catch (err: unknown) {
    // Server returned 846608: stream message inactive for >6 minutes, need to fall back to proactive send
    const errObj = err as { errmsg?: string; errcode?: number; message?: string } | undefined;
    const errMsg = String(errObj?.errmsg || errObj?.message || err);
    if (
      errObj?.errcode === STREAM_EXPIRED_ERRCODE ||
      errMsg.includes(String(STREAM_EXPIRED_ERRCODE))
    ) {
      throw new StreamExpiredError(errMsg);
    }
    throw err;
  }
  runtime.log?.(`[plugin -> server] streamId=${streamId}, finish=${finish}`);

  return streamId;
}

// ============================================================================
// 非阻塞流式发送（用于 onPartialReply 场景）
// ============================================================================

/**
 * 非阻塞流式文本回复
 *
 * 基于 SDK 的 replyStreamNonBlocking 方法：
 * - 如果上一条同 reqId 的消息尚未收到 ack，则跳过本次发送（返回 'skipped'），
 *   避免流式中间帧排队积压导致延迟。
 * - finish=true 的最终帧不受此限制，始终保证发送。
 *
 * @returns 'skipped' 表示被跳过，否则返回 streamId
 */
export async function sendWeComReplyNonBlocking(params: {
  wsClient: WSClient;
  frame: WsFrame;
  text: string;
  runtime: RuntimeEnv;
  streamId: string;
  finish?: boolean;
}): Promise<string> {
  const { wsClient, frame, text, runtime: _runtime, streamId, finish = false } = params;

  if (!text) {
    return "skipped";
  }

  if (!wsClient.isConnected) {
    return "skipped";
  }

  try {
    const result = await wsClient.replyStreamNonBlocking(frame, streamId, text, finish);
    if (result === "skipped") {
      return "skipped";
    }
    return streamId;
  } catch (err: unknown) {
    // Server returned 846608: stream message inactive for >6 minutes, need to fall back to proactive send
    const errObj = err as { errmsg?: string; errcode?: number; message?: string } | undefined;
    const errMsg = String(errObj?.errmsg || errObj?.message || err);
    if (
      errObj?.errcode === STREAM_EXPIRED_ERRCODE ||
      errMsg.includes(String(STREAM_EXPIRED_ERRCODE))
    ) {
      throw new StreamExpiredError(errMsg);
    }
    throw err;
  }
}
