import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { sendC2CMsgBody, sendGroupMsgBody } from "../../infra/transport.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { SendResult } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

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
  traceContext?: YuanbaoTraceContext;
}

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
