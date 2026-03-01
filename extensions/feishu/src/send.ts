/**
 * Feishu send API - delegates to core runtime.channel.feishu.
 * Re-exports for backward compatibility with consumers of @openclaw/feishu.
 */
import type {
  FeishuSendResult,
  FeishuMentionTarget,
  FeishuMessageInfo,
  SendFeishuMessageParams,
  SendFeishuCardParams,
} from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";

export type { FeishuSendResult, FeishuMessageInfo, SendFeishuMessageParams, SendFeishuCardParams };
export type MentionTarget = FeishuMentionTarget;

const feishu = () => getFeishuRuntime().channel.feishu;

export async function getMessageFeishu(params: {
  cfg: SendFeishuMessageParams["cfg"];
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  return feishu().getMessageFeishu(params);
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  return feishu().sendMessageFeishu(params);
}

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  return feishu().sendCardFeishu(params);
}

export async function updateCardFeishu(params: {
  cfg: SendFeishuCardParams["cfg"];
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  return feishu().updateCardFeishu(params);
}

export function buildMarkdownCard(text: string): Record<string, unknown> {
  return feishu().buildMarkdownCard(text);
}

export async function sendMarkdownCardFeishu(params: {
  cfg: SendFeishuMessageParams["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  mentions?: FeishuMentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  return feishu().sendMarkdownCardFeishu(params);
}

export async function editMessageFeishu(params: {
  cfg: SendFeishuMessageParams["cfg"];
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  return feishu().editMessageFeishu(params);
}
