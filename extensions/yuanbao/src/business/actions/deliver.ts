/**
 * Message delivery layer.
 *
 * Wraps C2C/group chat differences, auto-routes to the corresponding transport function based on SendTarget.
 * Used by create-sender and actions/xxx/send.ts.
 *
 * Internally calls transport.sendC2CMsgBody / transport.sendGroupMsgBody directly.
 */

import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { sendC2CMsgBody, sendGroupMsgBody } from "../../infra/transport.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { SendResult } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

// ============ Type definitions ============

/** Minimal context required by deliver */
export interface DeliverTarget {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C: toAccount; group chat: groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  /** Trace context for injecting trace_id / msg_seq into outbound messages */
  traceContext?: YuanbaoTraceContext;
}

// ============ Core delivery function ============

/**
 * Unified message delivery.
 * Auto-routes to C2C or group chat transport based on isGroup flag.
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
