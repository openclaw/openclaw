// Whatsapp plugin module implements group policy behavior.
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  type ChannelGroupPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type WhatsAppGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  groupSubject?: string | null;
  /** Agent runtime passes WhatsApp GroupSubject through the generic groupChannel field. */
  groupChannel?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

function normalizeGroupCandidate(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function whatsappGroupCandidates(params: WhatsAppGroupContext): string[] {
  return Array.from(
    new Set(
      [params.groupId, params.groupSubject, params.groupChannel]
        .map((candidate) => normalizeGroupCandidate(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ),
  );
}

function resolveWhatsAppMatchedGroupId(params: WhatsAppGroupContext): string | undefined {
  const candidates = whatsappGroupCandidates(params);
  for (const groupId of candidates) {
    const policy = resolveChannelGroupPolicy({
      cfg: params.cfg,
      channel: "whatsapp",
      groupId,
      accountId: params.accountId,
    });
    if (policy.groupConfig) {
      return groupId;
    }
  }
  return candidates[0];
}

export function resolveWhatsAppChannelGroupPolicy(
  params: WhatsAppGroupContext & { hasGroupAllowFrom?: boolean },
): ChannelGroupPolicy {
  const candidates = whatsappGroupCandidates(params);
  let fallback: ChannelGroupPolicy | undefined;
  for (const groupId of candidates) {
    const policy = resolveChannelGroupPolicy({
      cfg: params.cfg,
      channel: "whatsapp",
      groupId,
      accountId: params.accountId,
      hasGroupAllowFrom: params.hasGroupAllowFrom,
    });
    fallback ??= policy;
    if (policy.groupConfig) {
      return policy;
    }
  }
  return (
    fallback ??
    resolveChannelGroupPolicy({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: params.accountId,
      hasGroupAllowFrom: params.hasGroupAllowFrom,
    })
  );
}

export function resolveWhatsAppGroupRequireMention(params: WhatsAppGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: resolveWhatsAppMatchedGroupId(params),
    accountId: params.accountId,
  });
}

export function resolveWhatsAppGroupToolPolicy(
  params: WhatsAppGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: params.groupId,
    groupIdCandidates: whatsappGroupCandidates(params).filter(
      (candidate) => candidate !== normalizeGroupCandidate(params.groupId),
    ),
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
