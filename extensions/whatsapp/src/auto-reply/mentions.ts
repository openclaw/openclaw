import {
  buildMentionRegexes,
  normalizeMentionText,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { getMentionIdentities, getSelfIdentity, identitiesOverlap } from "../identity.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { isSelfChatMode } from "../targets-runtime.js";

export type MentionConfig = {
  mentionRegexes: RegExp[];
  allowFrom?: Array<string | number>;
  isSelfChat?: boolean;
};

export function buildMentionConfig(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: Parameters<typeof buildMentionRegexes>[2],
): MentionConfig {
  const mentionRegexes = buildMentionRegexes(cfg, agentId, options);
  return { mentionRegexes, allowFrom: cfg.channels?.whatsapp?.allowFrom };
}

export function isBotMentioned(
  msg: AdmittedWebInboundMessage,
  mentionCfg: MentionConfig,
  authDir?: string,
): boolean {
  const targets = {
    normalizedMentions: getMentionIdentities(msg, authDir),
    self: getSelfIdentity(msg, authDir),
  };
  // Having our own number in allowFrom suppresses native self-mentions only in DMs.
  // Explicit caller overrides also apply to groups.
  const admission = msg.admission;
  const isGroupConversation = admission.conversation.kind === "group";
  const isSelfChat =
    mentionCfg.isSelfChat ??
    (isSelfChatMode(targets.self.e164, mentionCfg.allowFrom) && !isGroupConversation);

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

export function resolveOwnerList(mentionCfg: MentionConfig, selfE164?: string | null) {
  const allowFrom = mentionCfg.allowFrom;
  const raw = allowFrom?.length ? allowFrom : selfE164 ? [selfE164] : [];
  return raw
    .filter((entry): entry is string => Boolean(entry && entry !== "*"))
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}
