import type { ClawdbotConfig } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { callDingtalkApi } from "./client.js";
import type { ResolvedDingtalkAccount, DingtalkSendResult } from "./types.js";

// 钉钉消息类型映射 / DingTalk message type mapping
export type DingtalkMsgKey =
  | "sampleText"
  | "sampleMarkdown"
  | "sampleImageMsg"
  | "sampleAudio"
  | "sampleFile"
  | "sampleVideo"
  | "sampleActionCard";

/**
 * 发送单聊消息 / Send DM message
 *
 * POST /v1.0/robot/oToMessages/batchSend
 */
export async function sendDingtalkDM(params: {
  account: ResolvedDingtalkAccount;
  userIds: string[];
  msgKey: DingtalkMsgKey;
  msgParam: string;
}): Promise<DingtalkSendResult> {
  const { account, userIds, msgKey, msgParam } = params;
  const robotCode = account.robotCode ?? account.clientId;
  if (!robotCode) {
    throw new Error(`DingTalk robotCode not configured for account "${account.accountId}"`);
  }

  const res = await callDingtalkApi<{ processQueryKey?: string }>({
    account,
    method: "POST",
    path: "/v1.0/robot/oToMessages/batchSend",
    data: {
      robotCode,
      userIds,
      msgKey,
      msgParam,
    },
  });

  return { processQueryKey: res.processQueryKey };
}

/**
 * 发送群聊消息 / Send group chat message
 *
 * POST /v1.0/robot/groupMessages/send
 */
export async function sendDingtalkGroup(params: {
  account: ResolvedDingtalkAccount;
  openConversationId: string;
  msgKey: DingtalkMsgKey;
  msgParam: string;
}): Promise<DingtalkSendResult> {
  const { account, openConversationId, msgKey, msgParam } = params;
  const robotCode = account.robotCode ?? account.clientId;
  if (!robotCode) {
    throw new Error(`DingTalk robotCode not configured for account "${account.accountId}"`);
  }

  const res = await callDingtalkApi<{ processQueryKey?: string }>({
    account,
    method: "POST",
    path: "/v1.0/robot/groupMessages/send",
    data: {
      robotCode,
      openConversationId,
      msgKey,
      msgParam,
    },
  });

  return { processQueryKey: res.processQueryKey };
}

/**
 * 发送文本消息（自动判断单聊/群聊） / Send text message (auto-detect DM/group)
 */
export async function sendTextMessage(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  text: string;
}): Promise<DingtalkSendResult> {
  const { account, conversationType, conversationId, senderStaffId, text } = params;
  const msgParam = JSON.stringify({ content: text });

  if (conversationType === "1") {
    return sendDingtalkDM({
      account,
      userIds: [senderStaffId],
      msgKey: "sampleText",
      msgParam,
    });
  }

  return sendDingtalkGroup({
    account,
    openConversationId: conversationId,
    msgKey: "sampleText",
    msgParam,
  });
}

/**
 * 发送 Markdown 消息 / Send Markdown message
 */
export async function sendMarkdownMessage(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  title: string;
  text: string;
}): Promise<DingtalkSendResult> {
  const { account, conversationType, conversationId, senderStaffId, title, text } = params;
  const msgParam = JSON.stringify({ title, text });

  if (conversationType === "1") {
    return sendDingtalkDM({
      account,
      userIds: [senderStaffId],
      msgKey: "sampleMarkdown",
      msgParam,
    });
  }

  return sendDingtalkGroup({
    account,
    openConversationId: conversationId,
    msgKey: "sampleMarkdown",
    msgParam,
  });
}

/**
 * 便捷方法：根据配置发送消息 / Convenience: send message from config
 */
export async function sendMessageDingtalk(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
}): Promise<DingtalkSendResult> {
  const account = resolveDingtalkAccount({ cfg: params.cfg, accountId: params.accountId });
  // 默认作为单聊发送 / Default to DM
  return sendDingtalkDM({
    account,
    userIds: [params.to],
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: params.text }),
  });
}
