/**
 * QQ typing lifecycle callbacks for the OpenClaw core typing controller.
 *
 * QQ shows a typing indicator for `input_second` (10s); the keepalive refresh
 * interval (5s) must stay below that window so consecutive ticks overlap
 * seamlessly. Unlike Telegram's pure heartbeat, every QQ typing tick spends
 * one of QQ's five-per-msg_id passive reply slots, so each tick claims against
 * the shared budget and falls back to a proactive (no msg_id) send when only
 * the reserved final-reply slot remains.
 */

import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { claimMessageReply } from "../messaging/outbound-reply.js";
import { clearTokenCache, createRawInputNotifyFn, getAccessToken } from "../messaging/sender.js";
import type { EngineLogger } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount } from "./types.js";

/** QQ input-notify display window: the server shows typing for this many seconds. */
export const TYPING_INPUT_SECOND = 10;
/** Refresh interval must be shorter than {@link TYPING_INPUT_SECOND} for seamless overlap. */
const TYPING_INTERVAL_MS = 5_000;
/** Stop keepalive after this many consecutive typing-start failures. */
const TYPING_MAX_CONSECUTIVE_FAILURES = 3;
/** Keep one passive-reply slot for the final text reply. */
const FINAL_REPLY_RESERVE_COUNT = 1;

/** Matches token-expiry / auth errors so the typing tick can refresh once. */
function isTokenError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("token") || msg.includes("401") || msg.includes("11244");
}

/** Typing options passed to {@link createChannelMessageReplyPipeline}. */
type QqTypingOptions = {
  start: () => Promise<void>;
  onStartError: (err: unknown) => void;
  keepaliveIntervalMs: number;
  maxConsecutiveFailures: number;
};

/**
 * Build core typing options for a C2C qqbot turn.
 *
 * The returned `start` runs on `onReplyStart` and each keepalive tick. It claims
 * the shared passive-reply budget (reserving one slot for the final reply) and
 * sends `input_notify` with `input_second`; when only the reserved slot
 * remains it switches to a proactive send without `msg_id` so a typing tick
 * never starves the final text reply.
 */
export function buildQqTypingOptions(params: {
  event: QueuedMessage;
  account: GatewayAccount;
  log?: EngineLogger;
}): QqTypingOptions {
  const { event, account, log } = params;
  const appId = account.appId;
  const clientSecret = account.clientSecret;
  const openid = event.senderId;
  const msgId = event.messageId;
  const rawNotifyFn = createRawInputNotifyFn(appId);
  const debug = (message: string) => log?.debug?.(message);

  const sendOnce = async (token: string, useMsgId: boolean): Promise<void> => {
    await rawNotifyFn(token, openid, useMsgId ? msgId : undefined, TYPING_INPUT_SECOND);
  };

  const sendTyping = async (): Promise<void> => {
    // Each wire attempt claims its own passive slot; reserve one for the final
    // reply so a long-running turn can't exhaust the budget before delivery.
    const claim = claimMessageReply(msgId, FINAL_REPLY_RESERVE_COUNT);
    const useMsgId = claim.allowed;
    if (!useMsgId) {
      debug(`Typing budget exhausted for ${openid}; sending proactive input_notify`);
    }
    try {
      const token = await getAccessToken(appId, clientSecret);
      await sendOnce(token, useMsgId);
      debug(`Typing tick sent to ${openid}`);
    } catch (err) {
      // Refresh the access token once on auth failure, mirroring the sender retry.
      if (!isTokenError(err)) {
        throw err;
      }
      clearTokenCache(appId);
      const token = await getAccessToken(appId, clientSecret);
      try {
        await sendOnce(token, useMsgId);
        debug(`Typing tick sent to ${openid} (after token refresh)`);
      } catch (retryErr) {
        debug(`Typing tick failed for ${openid}: ${formatErrorMessage(retryErr)}`);
        throw retryErr;
      }
    }
  };

  return {
    start: sendTyping,
    onStartError: (err) => {
      logTypingFailure({
        log: debug,
        channel: "qqbot",
        target: openid,
        error: err,
      });
    },
    keepaliveIntervalMs: TYPING_INTERVAL_MS,
    maxConsecutiveFailures: TYPING_MAX_CONSECUTIVE_FAILURES,
  };
}
