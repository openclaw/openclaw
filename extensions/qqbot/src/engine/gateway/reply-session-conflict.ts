// Shared detection, error-ID, and terminal-notice helpers for
// reply-session-init conflicts.
//
// ReplySessionInitConflictError is not exported through the plugin SDK, so
// every channel that needs to surface it must match the message pattern.

import {
  accountToCreds,
  buildDeliveryTarget,
  sendText as senderSendText,
} from "../messaging/sender.js";
import type { QueuedMessage } from "./message-queue.js";
import type { EngineLogger, GatewayAccount } from "./types.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;

/** True when `error` matches the shared core's `ReplySessionInitConflictError`. */
export function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

/** Short hex reference number for correlating logs with user-visible notices. */
function generateSessionConflictErrorId(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString(16).padStart(8, "0");
}

/** Dependencies injected to keep the function testable without a full gateway. */
interface SessionConflictTerminalNoticeDeps {
  event: QueuedMessage;
  account: GatewayAccount;
  log?: EngineLogger;
  senderSendText: typeof senderSendText;
  buildDeliveryTargetFn: typeof buildDeliveryTarget;
  accountToCredsFn: typeof accountToCreds;
}

/**
 * When shared-core retry ([#105754]) has exhausted, surface a best-effort
 * terminal notice to the QQ user.  The notice is deliberately terse and
 * carries an 8-char hex error reference for log correlation.  No internal
 * error text, session keys, or stack traces are exposed.
 *
 * If the terminal notice itself fails to send, the failure is logged at
 * ``terminal_notice_failed`` and the session's inbound work completes with
 * no delivery.  QQBot currently has no durable ingress or replay mechanism
 * to automatically recover the original message — that is
 * deferred to a follow-up PR.
 */
export async function sendReplySessionConflictTerminalNotice(
  error: unknown,
  deps: SessionConflictTerminalNoticeDeps,
): Promise<void> {
  if (!isReplySessionInitConflictError(error)) {
    return;
  }
  const {
    event,
    account,
    log,
    senderSendText: senderSendTextFn,
    buildDeliveryTargetFn,
    accountToCredsFn,
  } = deps;
  const errorId = generateSessionConflictErrorId();
  const terminalText = `当前消息因会话冲突未能处理，请重新发送。\n错误编号：${errorId}`;

  log?.error(
    `reply session init conflict exhausted — ` +
      `messageId=${event.messageId} ` +
      `senderId=${event.senderId} ` +
      `groupOpenid=${event.groupOpenid ?? ""} ` +
      `errorId=${errorId}`,
  );

  try {
    await senderSendTextFn(buildDeliveryTargetFn(event), terminalText, accountToCredsFn(account), {
      msgId: event.messageId,
    });
  } catch (sendErr) {
    const sendErrDetail = sendErr instanceof Error ? sendErr.message : String(sendErr);
    log?.error(
      `terminal_notice_failed — errorId=${errorId} ` +
        `messageId=${event.messageId}: ` +
        sendErrDetail,
    );
  }
}
