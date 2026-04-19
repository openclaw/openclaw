/**
 * Text message sending.
 *
 * Extracted from create-sender:
 * - Parses @mentions, Markdown image references, etc.
 * - Builds MsgBody and delivers via deliver()
 */

import { getMember } from "../../../infra/cache/member.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";

export interface SendTextParams {
  /** Text content to send */
  text: string;
  /** Delivery target context (isGroup / target / account, etc.) */
  dt: DeliverTarget;
}

/**
 * Send text message.
 * Prepares content (parses @mentions, Markdown image refs), builds MsgBody, and delivers.
 */
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
