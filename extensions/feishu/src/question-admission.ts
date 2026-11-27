import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import {
  resolveFeishuDmIngressAccess,
  resolveFeishuGroupConfig,
  resolveFeishuGroupSenderActivationIngressAccess,
} from "./policy.js";

/**
 * Authorize the person behind a question-card tap with the same Feishu
 * admission rules that gate ordinary inbound messages in this conversation.
 */
export async function authorizeFeishuQuestionCallback(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  chatId?: string;
  chatType?: "p2p" | "group";
  senderOpenId: string;
  senderUserId?: string | null;
}): Promise<boolean> {
  const chatId = params.chatId?.trim();
  if (!chatId) {
    return false;
  }
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const config = account.config;
  if (params.chatType === "group") {
    const groupConfig = resolveFeishuGroupConfig({ cfg: config, groupId: chatId });
    const groupAllowFrom =
      (groupConfig?.allowFrom?.length ?? 0) > 0
        ? groupConfig?.allowFrom
        : config.groupSenderAllowFrom;
    const allowFrom = groupAllowFrom ?? [];
    if (allowFrom.length === 0) {
      return true;
    }
    const result = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg: params.cfg,
      accountId: params.accountId,
      chatId,
      allowFrom,
      senderOpenId: params.senderOpenId,
      senderUserId: params.senderUserId,
      requireMention: false,
      mentionedBot: true,
    });
    return result.ingress.admission === "dispatch";
  }
  const dmPolicy = config.dmPolicy ?? "pairing";
  if (dmPolicy === "open" || dmPolicy === "allowall") {
    return true;
  }
  const result = await resolveFeishuDmIngressAccess({
    cfg: params.cfg,
    accountId: params.accountId,
    dmPolicy,
    allowFrom: config.allowFrom ?? [],
    senderOpenId: params.senderOpenId,
    senderUserId: params.senderUserId,
    conversationId: chatId,
    mayPair: false,
  });
  return result.ingress.admission === "dispatch";
}
