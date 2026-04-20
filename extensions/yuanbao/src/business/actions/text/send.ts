import { getMember } from "../../../infra/cache/member.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";

export interface SendTextParams {
  text: string;
  dt: DeliverTarget;
}

export async function sendText(params: SendTextParams): Promise<SendResult> {
  const { text, dt } = params;

  if (!text.trim()) {
    return { ok: true };
  }

  const { isGroup, target, account } = dt;
  const groupCode = isGroup ? target : undefined;
  const memberInst = isGroup ? getMember(account.accountId) : undefined;
  const items = prepareOutboundContent(text, groupCode, memberInst);
  const msgBody = buildOutboundMsgBody(items) as YuanbaoMsgBodyElement[];

  return deliver(dt, msgBody);
}
