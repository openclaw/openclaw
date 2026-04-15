/**
 * Text message sending
 *
 * 从 create-sender 中拆出的文本发送逻辑：
 * - 解析 @用户、Markdown Image引用等
 * - 构建 MsgBody 并通过 deliver 投递
 */

import { getMember } from "../../../infra/cache/member.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";

export interface SendTextParams {
  /** 要发送的文本内容 */
  text: string;
  /** 投递目标上下文（isGroup / target / account 等均从此获取） */
  dt: DeliverTarget;
}

/**
 * Send text message
 *
 * 文本内容准备：解析 @用户、Markdown Image引用等，
 * 构建 MsgBody 后通过 deliver 投递。
 *
 * @param params - 发送参数
 * @returns 发送结果
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
