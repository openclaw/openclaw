import {
  buildMentionRegexes,
  normalizeMentionText
} from "../../../../src/auto-reply/reply/mentions.js";
import { isSelfChatMode, jidToE164, normalizeE164 } from "../../../../src/utils.js";
function buildMentionConfig(cfg, agentId) {
  const mentionRegexes = buildMentionRegexes(cfg, agentId);
  return { mentionRegexes, allowFrom: cfg.channels?.whatsapp?.allowFrom };
}
function resolveMentionTargets(msg, authDir) {
  const jidOptions = authDir ? { authDir } : void 0;
  const normalizedMentions = msg.mentionedJids?.length ? msg.mentionedJids.map((jid) => jidToE164(jid, jidOptions) ?? jid).filter(Boolean) : [];
  const selfE164 = msg.selfE164 ?? (msg.selfJid ? jidToE164(msg.selfJid, jidOptions) : null);
  const selfJid = msg.selfJid ? msg.selfJid.replace(/:\\d+/, "") : null;
  return { normalizedMentions, selfE164, selfJid };
}
function isBotMentionedFromTargets(msg, mentionCfg, targets) {
  const clean = (text) => (
    // Remove zero-width and directionality markers WhatsApp injects around display names
    normalizeMentionText(text)
  );
  const isSelfChat = isSelfChatMode(targets.selfE164, mentionCfg.allowFrom);
  const hasMentions = (msg.mentionedJids?.length ?? 0) > 0;
  if (hasMentions && !isSelfChat) {
    if (targets.selfE164 && targets.normalizedMentions.includes(targets.selfE164)) {
      return true;
    }
    if (targets.selfJid) {
      if (targets.normalizedMentions.includes(targets.selfJid)) {
        return true;
      }
    }
    return false;
  } else if (hasMentions && isSelfChat) {
  }
  const bodyClean = clean(msg.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) {
    return true;
  }
  if (targets.selfE164) {
    const selfDigits = targets.selfE164.replace(/\D/g, "");
    if (selfDigits) {
      const bodyDigits = bodyClean.replace(/[^\d]/g, "");
      if (bodyDigits.includes(selfDigits)) {
        return true;
      }
      const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
      const pattern = new RegExp(`\\+?${selfDigits}`, "i");
      if (pattern.test(bodyNoSpace)) {
        return true;
      }
    }
  }
  return false;
}
function debugMention(msg, mentionCfg, authDir) {
  const mentionTargets = resolveMentionTargets(msg, authDir);
  const result = isBotMentionedFromTargets(msg, mentionCfg, mentionTargets);
  const details = {
    from: msg.from,
    body: msg.body,
    bodyClean: normalizeMentionText(msg.body),
    mentionedJids: msg.mentionedJids ?? null,
    normalizedMentionedJids: mentionTargets.normalizedMentions.length ? mentionTargets.normalizedMentions : null,
    selfJid: msg.selfJid ?? null,
    selfJidBare: mentionTargets.selfJid,
    selfE164: msg.selfE164 ?? null,
    resolvedSelfE164: mentionTargets.selfE164
  };
  return { wasMentioned: result, details };
}
function resolveOwnerList(mentionCfg, selfE164) {
  const allowFrom = mentionCfg.allowFrom;
  const raw = Array.isArray(allowFrom) && allowFrom.length > 0 ? allowFrom : selfE164 ? [selfE164] : [];
  return raw.filter((entry) => Boolean(entry && entry !== "*")).map((entry) => normalizeE164(entry)).filter((entry) => Boolean(entry));
}
export {
  buildMentionConfig,
  debugMention,
  isBotMentionedFromTargets,
  resolveMentionTargets,
  resolveOwnerList
};
