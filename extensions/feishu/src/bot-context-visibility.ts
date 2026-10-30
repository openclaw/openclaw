import { evaluateSupplementalContextVisibility, type ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuGroupSenderActivationIngressAccess } from "./policy.js";

export async function shouldIncludeFetchedGroupContextMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  isGroup: boolean;
  allowFrom: Array<string | number>;
  mode: "all" | "allowlist" | "allowlist_quote";
  kind: "quote" | "thread" | "history";
  senderId?: string;
  senderType?: string;
}): Promise<boolean> {
  let senderAllowed =
    !params.isGroup || params.allowFrom.length === 0 || params.senderType === "app";
  const senderId = params.senderId?.trim();
  if (!senderAllowed && senderId) {
    const access = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg: params.cfg,
      accountId: params.accountId,
      chatId: params.chatId,
      allowFrom: params.allowFrom,
      senderOpenId: senderId,
      senderUserId: senderId,
      requireMention: false,
      mentionedBot: true,
    });
    senderAllowed = access.senderAccess.decision === "allow";
  }
  return evaluateSupplementalContextVisibility({
    mode: params.mode,
    kind: params.kind,
    senderAllowed,
  }).include;
}
