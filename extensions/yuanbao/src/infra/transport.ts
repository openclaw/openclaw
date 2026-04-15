/**
 * Transport 层
 *
 * 所有通过 WebSocket 发送消息的基础逻辑统一收归于此。
 * - sendC2CMsgBody：调用 wsClient 发送 C2C 消息，自带日志
 * - sendGroupMsgBody：调用 wsClient 发送群消息，自带日志
 *
 * 高层文本发送逻辑（包含 prepareOutboundContent + buildOutboundMsgBody）
 * 已统一收归到 business/actions/text/send.ts 的 sendText action。
 */

import type { YuanbaoWsClient } from "../access/ws/client.js";
import type { SendResult } from "../business/outbound/types.js";
import type { YuanbaoTraceContext } from "../business/trace/context.js";
import { createLog } from "../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../types.js";
import { getMember } from "./cache/member.js";
import { InMemoryTtlDb } from "./cache/ttl-db.js";

// ============ 引用回复去重 ============

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

  // 避免自引用：比较被回复消息的发送者账号
  if (refFromAccount) {
    const yuanbaoUserId = await getMember(account.accountId).queryYuanbaoUserId(groupCode);
    if (yuanbaoUserId && refFromAccount === yuanbaoUserId) {
      return false;
    }
  }

  if (mode === "all") {
    return true;
  }

  // first 模式：同一入站消息仅首次引用
  const dedupeKey = `${account.accountId}:${refMsgId}`;
  if (firstReplyRefDb.has(dedupeKey)) {
    return false;
  }
  firstReplyRefDb.set(dedupeKey, true);
  return true;
}

// ============ 基础发送（自带日志） ============

/** 通过 WebSocket 发送 C2C Message body */
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

/** 通过 WebSocket 发送群Message body */
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
