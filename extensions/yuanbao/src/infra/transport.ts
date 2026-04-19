/**
 * Transport layer — low-level WebSocket message sending with logging.
 *
 * Higher-level text sending logic lives in business/actions/text/send.ts.
 */

import type { YuanbaoWsClient } from "../access/ws/client.js";
import type { SendResult } from "../business/outbound/types.js";
import type { YuanbaoTraceContext } from "../business/trace/context.js";
import { createLog } from "../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../types.js";
import { getMember } from "./cache/member.js";
import { InMemoryTtlDb } from "./cache/ttl-db.js";

// ============ Quote-reply deduplication ============

const firstReplyRefDb = new InMemoryTtlDb<string, true>({
  ttlMs: 60 * 1000,
  maxKeys: 100,
});

/**
 * Whether a quote reply should be attached
 */
async function shouldAttachReplyRef(params: {
  account: ResolvedYuanbaoAccount;
  refMsgId?: string;
  groupCode?: string;
  refFromAccount?: string;
}): Promise<boolean> {
  const { account, refMsgId, groupCode, refFromAccount } = params;
  if (!refMsgId) {
    return false;
  }

  const mode = account.replyToMode;
  if (mode === "off") {
    return false;
  }

  // Avoid self-quoting: compare the sender of the replied message
  if (refFromAccount) {
    const yuanbaoUserId = await getMember(account.accountId).queryYuanbaoUserId(groupCode);
    if (yuanbaoUserId && refFromAccount === yuanbaoUserId) {
      return false;
    }
  }

  if (mode === "all") {
    return true;
  }

  // "first" mode: only attach quote for the first reply to the same inbound message
  const dedupeKey = `${account.accountId}:${refMsgId}`;
  if (firstReplyRefDb.has(dedupeKey)) {
    return false;
  }
  firstReplyRefDb.set(dedupeKey, true);
  return true;
}

// ============ Core send helpers (with logging) ============

/** Send a C2C message body via WebSocket. */
export async function sendC2CMsgBody(params: {
  account: ResolvedYuanbaoAccount;
  toAccount: string;
  msgBody: YuanbaoMsgBodyElement[];
  fromAccount?: string;
  wsClient: YuanbaoWsClient;
  groupCode?: string;
  traceContext?: YuanbaoTraceContext;
}): Promise<SendResult> {
  const { toAccount, msgBody, fromAccount, wsClient, groupCode, traceContext } = params;
  const log = createLog("transport");
  const msgRandom = Math.floor(Math.random() * 4294967295);

  try {
    const result = await wsClient.sendC2CMessage({
      to_account: toAccount,
      msg_body: msgBody,
      msg_random: msgRandom,
      ...(groupCode ? { group_code: groupCode } : {}),
      ...(fromAccount ? { from_account: fromAccount } : {}),
      ...(traceContext ? { trace_id: traceContext.traceId } : {}),
      ...(traceContext ? { msg_seq: traceContext.nextMsgSeq() } : {}),
    });

    const sendResult: SendResult = {
      ok: result.code === 0,
      messageId: result.msgId,
      error: result.code !== 0 ? result.message || `code: ${result.code}` : undefined,
    };

    if (!sendResult.ok) {
      log.error("[C2C] send failed", { error: sendResult.error });
    } else {
      log.info("[C2C] send ok", { toAccount, msgId: sendResult.messageId });
    }

    return sendResult;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("[C2C] send error", { error });
    return { ok: false, error };
  }
}

/** Send a group message body via WebSocket. */
export async function sendGroupMsgBody(params: {
  account: ResolvedYuanbaoAccount;
  groupCode: string;
  msgBody: YuanbaoMsgBodyElement[];
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  traceContext?: YuanbaoTraceContext;
}): Promise<SendResult> {
  const {
    account,
    groupCode,
    msgBody,
    fromAccount,
    refMsgId,
    refFromAccount,
    wsClient,
    traceContext,
  } = params;
  const log = createLog("transport");
  const msgRandom = String(Math.floor(Math.random() * 4294967295));
  const attachRef = await shouldAttachReplyRef({ account, refMsgId, groupCode, refFromAccount });

  try {
    const result = await wsClient.sendGroupMessage({
      msg_id: refMsgId,
      group_code: groupCode,
      random: msgRandom,
      msg_body: msgBody,
      ...(fromAccount ? { from_account: fromAccount } : {}),
      ...(attachRef ? { ref_msg_id: refMsgId } : {}),
      ...(traceContext ? { trace_id: traceContext.traceId } : {}),
      ...(traceContext ? { msg_seq: traceContext.nextMsgSeq() } : {}),
    });

    const sendResult: SendResult = {
      ok: result.code === 0,
      messageId: result.msgId,
      error: result.code !== 0 ? result.message || `code: ${result.code}` : undefined,
    };

    if (!sendResult.ok) {
      log.error("[group] send failed", { error: sendResult.error });
    } else {
      log.info("[group] send ok", { groupCode, msgId: sendResult.messageId });
    }

    return sendResult;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("[group] send error", { error });
    return { ok: false, error };
  }
}
