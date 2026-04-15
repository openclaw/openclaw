/**
 * Message delivery layer
 *
 * 封装 C2C/群聊差异，根据 SendTarget 自动路由到对应的 transport 底层函数。
 * 由 create-sender 和各 actions/xxx/send.ts 使用。
 *
 * 内部直接调用 transport.sendC2CMsgBody / transport.sendGroupMsgBody，
 * 不再需要外部传入 deliverMsgBody 回调。
 */

import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { sendC2CMsgBody, sendGroupMsgBody } from "../../infra/transport.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { SendResult } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

// ============ 类型定义 ============

/** deliver 所需的最小上下文 */
export interface DeliverTarget {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C 为 toAccount，群聊为 groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  /** Trace context，用于在出站消息中注入 trace_id / msg_seq */
  traceContext?: YuanbaoTraceContext;
}

// ============ 核心投递函数 ============

/**
 * Unified message delivery
 *
 * 根据 isGroup 自动路由到 C2C 或群聊的 transport 底层发送函数。
 *
 * @param dt - 投递目标上下文
 * @param msgBody - 要发送的Message body
 * @returns 发送结果
 */
export async function deliver(
  dt: DeliverTarget,
  msgBody: YuanbaoMsgBodyElement[],
): Promise<SendResult> {
  return dt.isGroup
    ? sendGroupMsgBody({
        account: dt.account,
        groupCode: dt.target,
        msgBody,
        fromAccount: dt.fromAccount,
        refMsgId: dt.refMsgId,
        refFromAccount: dt.refFromAccount,
        wsClient: dt.wsClient,
        traceContext: dt.traceContext,
      })
    : sendC2CMsgBody({
        account: dt.account,
        toAccount: dt.target,
        msgBody,
        fromAccount: dt.fromAccount,
        wsClient: dt.wsClient,
        groupCode: dt.groupCode,
        traceContext: dt.traceContext,
      });
}
