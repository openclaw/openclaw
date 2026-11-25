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
  const normalizedMentions = getMentionIdentities(msg, authDir);
  const self = getSelfIdentity(msg, authDir);
  // Having our own number in allowFrom suppresses native self-mentions only in DMs.
  // Explicit caller overrides also apply to groups.
  const admission = msg.admission;
  const isGroupConversation = admission.conversation.kind === "group";
  const isSelfChat =
    mentionCfg.isSelfChat ??
    (isSelfChatMode(self.e164, mentionCfg.allowFrom) && !isGroupConversation);

  const hasNativeMentionsOutsideSelfChat = normalizedMentions.length > 0 && !isSelfChat;
  if (!isSelfChat && normalizedMentions.some((mention) => identitiesOverlap(self, mention))) {
    return true;
  }
  const bodyClean = normalizeMentionText(msg.payload.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) {
    return true;
  }

  // Mentions of other participants must not activate the self-number fallback.
  if (hasNativeMentionsOutsideSelfChat) {
    return false;
  }

  const selfDigits = self.e164?.replace(/\D/g, "");
  return Boolean(
    selfDigits &&
    new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_@])@\\+?${selfDigits}(?![\\p{L}\\p{N}\\p{M}_@])`, "u").test(
      msg.payload.body,
    ),
  );
}

export function resolveOwnerList(mentionCfg: MentionConfig, selfE164?: string | null) {
  const allowFrom = mentionCfg.allowFrom;
  const raw = allowFrom?.length ? allowFrom : selfE164 ? [selfE164] : [];
  return raw
    .filter((entry): entry is string => Boolean(entry && entry !== "*"))
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}
