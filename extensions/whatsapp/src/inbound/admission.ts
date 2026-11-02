import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";

type WhatsAppInboundAdmissionAccess = {
  ingress: Pick<
    ResolvedChannelMessageIngress["ingress"],
    "admission" | "decision" | "decisiveGateId" | "reasonCode"
  >;
  senderAccess: Pick<
    ResolvedChannelMessageIngress["senderAccess"],
    "allowed" | "decision" | "reasonCode" | "providerMissingFallbackApplied"
  >;
  commandAccess: Pick<
    ResolvedChannelMessageIngress["commandAccess"],
    "requested" | "authorized" | "shouldBlockControlCommand" | "reasonCode"
  >;
  activationAccess: Pick<
    ResolvedChannelMessageIngress["activationAccess"],
    "ran" | "allowed" | "shouldSkip" | "reasonCode"
  >;
};

type WhatsAppInboundAdmissionPolicy = {
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  isSelfChat: boolean;
  isSamePhone: (value?: string | null) => boolean;
};

/** Accepted ingress facts exclude raw allowlists and session-dependent state. */
export type WhatsAppInboundAdmission = WhatsAppInboundAdmissionAccess & {
  channelIngress?: ResolvedChannelMessageIngress;
  accountId: string;
  isSelfChat: boolean;
  account: WhatsAppInboundAdmissionPolicy["account"];
  conversation: {
    kind: "direct" | "group";
    id: string;
    groupSessionId: string;
  };
  sender: {
    id: string;
    isSamePhone: boolean;
  };
};

type WhatsAppIngressResolver = (
  contextBinding: ChannelIngressContextBinding,
) => Promise<ResolvedChannelMessageIngress>;
const ingressResolverByAdmission = new WeakMap<WhatsAppInboundAdmission, WhatsAppIngressResolver>();

export function buildWhatsAppInboundAdmission(params: {
  policy: WhatsAppInboundAdmissionPolicy;
  access: WhatsAppInboundAdmissionAccess;
  channelIngress?: ResolvedChannelMessageIngress;
  resolveChannelIngress?: WhatsAppIngressResolver;
  isGroup: boolean;
  conversationId: string;
  senderId: string;
}): WhatsAppInboundAdmission {
  const { accountId, name, enabled, sendReadReceipts, selfChatMode, replyToMode } =
    params.policy.account;
  const admission: WhatsAppInboundAdmission = {
    channelIngress: params.channelIngress,
    accountId: params.policy.account.accountId,
    isSelfChat: params.policy.isSelfChat,
    account: { accountId, name, enabled, sendReadReceipts, selfChatMode, replyToMode },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
      groupSessionId: resolveWhatsAppGroupConversationId(params.conversationId),
    },
    sender: {
      id: params.senderId,
      isSamePhone: params.policy.isSamePhone(params.senderId),
    },
    ingress: {
      admission: params.access.ingress.admission,
      decision: params.access.ingress.decision,
      decisiveGateId: params.access.ingress.decisiveGateId,
      reasonCode: params.access.ingress.reasonCode,
    },
    senderAccess: {
      allowed: params.access.senderAccess.allowed,
      decision: params.access.senderAccess.decision,
      reasonCode: params.access.senderAccess.reasonCode,
      providerMissingFallbackApplied: params.access.senderAccess.providerMissingFallbackApplied,
    },
    commandAccess: {
      requested: params.access.commandAccess.requested,
      authorized: params.access.commandAccess.authorized,
      shouldBlockControlCommand: params.access.commandAccess.shouldBlockControlCommand,
      reasonCode: params.access.commandAccess.reasonCode,
    },
    activationAccess: {
      ran: params.access.activationAccess.ran,
      allowed: params.access.activationAccess.allowed,
      shouldSkip: params.access.activationAccess.shouldSkip,
      reasonCode: params.access.activationAccess.reasonCode,
    },
  };
  if (params.resolveChannelIngress) {
    ingressResolverByAdmission.set(admission, params.resolveChannelIngress);
  }
  return admission;
}

export async function resolveWhatsAppAdmissionChannelIngress(
  admission: WhatsAppInboundAdmission,
  contextBinding: ChannelIngressContextBinding,
): Promise<ResolvedChannelMessageIngress | undefined> {
  return await ingressResolverByAdmission.get(admission)?.(contextBinding);
}
