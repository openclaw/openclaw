// WhatsApp transport binding for numbered ask_user reactions.
import type { WAMessage } from "baileys";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { listWhatsAppDeliveredMessageIdentities } from "./inbound/send-result.js";

type WhatsAppQuestionReactionIdentity = {
  accountId: string;
  remoteJid: string;
  messageId: string;
};

function buildKey(identity: WhatsAppQuestionReactionIdentity): string | undefined {
  const parts = [identity.accountId, identity.remoteJid, identity.messageId].map((part) =>
    part.trim(),
  );
  return parts.every(Boolean) ? parts.join(":") : undefined;
}

const questionReactionTargets = createQuestionReactionTargetStore({
  channel: "whatsapp",
  channelDisplayName: "WhatsApp",
  buildKey,
  registerChannelDelivery: questionGatewayRuntime.registerChannelDelivery,
  resolveReaction: questionGatewayRuntime.resolveReaction,
});

export function registerWhatsAppQuestionReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "whatsapp" || !binding) {
    return false;
  }
  const accountId = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.target.accountId,
  }).accountId;
  let registered = false;
  for (const identity of listWhatsAppDeliveredMessageIdentities(params.results, () => true)) {
    registered =
      questionReactionTargets.register(binding, { accountId, ...identity }) || registered;
  }
  return registered;
}

export async function maybeResolveWhatsAppQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WAMessage;
  senderId: string;
  gatewayUrl?: string;
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const reaction = params.msg.message?.reactionMessage;
  const reactionKey = reaction?.text?.trim() ?? "";
  const messageId = reaction?.key?.id?.trim() ?? "";
  const optionIndex = questionGatewayRuntime.resolveReactionIndex(reactionKey);
  if (optionIndex === undefined || !messageId) {
    return false;
  }
  const remoteJids = normalizeUniqueTrimmedStringList([
    reaction?.key?.remoteJid,
    params.msg.key?.remoteJid,
  ]);
  const candidates: string[] = [];
  for (const remoteJid of remoteJids) {
    candidates.push(remoteJid, ...((await params.resolveReactionTargetJids?.(remoteJid)) ?? []));
  }
  return await questionReactionTargets.resolve({
    identities: normalizeUniqueTrimmedStringList(candidates).map((remoteJid) => ({
      accountId: params.accountId,
      remoteJid,
      messageId,
    })),
    optionIndex,
    cfg: params.cfg,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    logDebug: params.logDebug,
  });
}
