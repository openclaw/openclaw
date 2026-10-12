import {
  buildMentionRegexes,
  normalizeMentionText,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  getComparableIdentityValues,
  getMentionIdentities,
  getSelfIdentity,
  identitiesOverlap,
  type WhatsAppIdentity,
} from "../identity.js";
import { requireWhatsAppInboundAdmission } from "../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { isSelfChatMode } from "../targets-runtime.js";

export type MentionConfig = {
  mentionRegexes: RegExp[];
  allowFrom?: Array<string | number>;
  isSelfChat?: boolean;
};

type MentionTargets = {
  normalizedMentions: WhatsAppIdentity[];
  self: WhatsAppIdentity;
};

export function buildMentionConfig(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: Parameters<typeof buildMentionRegexes>[2],
): MentionConfig {
  const mentionRegexes = buildMentionRegexes(cfg, agentId, options);
  return { mentionRegexes, allowFrom: cfg.channels?.whatsapp?.allowFrom };
}

function resolveMentionTargets(msg: AdmittedWebInboundMessage, authDir?: string): MentionTargets {
  const normalizedMentions = getMentionIdentities(msg, authDir);
  const self = getSelfIdentity(msg, authDir);
  return { normalizedMentions, self };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderAgentFacingMentionText(params: {
  msg: AdmittedWebInboundMessage;
  identityName?: string;
  authDir?: string;
}): string {
  const targets = resolveMentionTargets(params.msg, params.authDir);
  const selfMentionIds = targets.normalizedMentions
    .flatMap((mention) =>
      identitiesOverlap(targets.self, mention) ? [mention.jid, mention.lid] : [],
    )
    .filter((jid): jid is string => Boolean(jid))
    .map((jid) => jid.split("@")[0]?.trim())
    .filter((id): id is string => Boolean(id));
  if (selfMentionIds.length === 0) {
    return params.msg.payload.body;
  }

  const replacement = `@${params.identityName?.trim() || "assistant"}`;
  return [...new Set(selfMentionIds)].reduce(
    (body, id) =>
      body.replace(
        new RegExp(`@${escapeRegExp(id)}(?=$|[^\\p{L}\\p{N}_])`, "gu"),
        () => replacement,
      ),
    params.msg.payload.body,
  );
}

function isBotMentionedFromTargets(
  msg: AdmittedWebInboundMessage,
  mentionCfg: MentionConfig,
  targets: MentionTargets,
): boolean {
  const explicitSelfChatOverride = typeof mentionCfg.isSelfChat === "boolean";
  // Having our own number in allowFrom suppresses native self-mentions only in DMs.
  // Explicit caller overrides also apply to groups.
  const admission = requireWhatsAppInboundAdmission(msg);
  const isGroupConversation = admission.conversation.kind === "group";
  const isSelfChat = explicitSelfChatOverride
    ? Boolean(mentionCfg.isSelfChat)
    : isSelfChatMode(targets.self.e164, mentionCfg.allowFrom) && !isGroupConversation;

  const hasMentions = targets.normalizedMentions.length > 0;
  const hasNativeMentionsOutsideSelfChat = hasMentions && !isSelfChat;
  if (hasNativeMentionsOutsideSelfChat) {
    for (const mention of targets.normalizedMentions) {
      if (identitiesOverlap(targets.self, mention)) {
        return true;
      }
    }
  }
  const bodyClean = normalizeMentionText(msg.payload.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) {
    return true;
  }

  // Native mentions for other participants inject their identities into the
  // body, so they must not activate the loose self-number fallback below.
  if (hasNativeMentionsOutsideSelfChat) {
    return false;
  }

  const selfDigits = targets.self.e164?.replace(/\D/g, "");
  return Boolean(selfDigits && bodyClean.replace(/\D/g, "").includes(selfDigits));
}

export function debugMention(
  msg: AdmittedWebInboundMessage,
  mentionCfg: MentionConfig,
  authDir?: string,
): { wasMentioned: boolean; details: Record<string, unknown> } {
  const mentionTargets = {
    normalizedMentions: getMentionIdentities(msg, authDir),
    self: getSelfIdentity(msg, authDir),
  };
  const result = isBotMentionedFromTargets(msg, mentionCfg, mentionTargets);
  const admission = requireWhatsAppInboundAdmission(msg);
  const details = {
    from: admission.conversation.id,
    body: msg.payload.body,
    bodyClean: normalizeMentionText(msg.payload.body),
    mentionedJids: msg.group?.mentions?.jids ?? null,
    normalizedMentionedJids: mentionTargets.normalizedMentions.length
      ? mentionTargets.normalizedMentions.map((identity) => getComparableIdentityValues(identity))
      : null,
    selfJid: msg.platform.self?.jid ?? msg.platform.selfJid ?? null,
    selfLid: msg.platform.self?.lid ?? msg.platform.selfLid ?? null,
    selfE164: msg.platform.self?.e164 ?? msg.platform.selfE164 ?? null,
    resolvedSelf: mentionTargets.self,
  };
  return { wasMentioned: result, details };
}

export function resolveOwnerList(mentionCfg: MentionConfig, selfE164?: string | null) {
  const allowFrom = mentionCfg.allowFrom;
  const raw =
    Array.isArray(allowFrom) && allowFrom.length > 0 ? allowFrom : selfE164 ? [selfE164] : [];
  return raw
    .filter((entry): entry is string => Boolean(entry && entry !== "*"))
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}
