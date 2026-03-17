function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractMentionTargets(event, botOpenId) {
  const mentions = event.message.mentions ?? [];
  return mentions.filter((m) => {
    if (botOpenId && m.id.open_id === botOpenId) {
      return false;
    }
    return !!m.id.open_id;
  }).map((m) => ({
    openId: m.id.open_id,
    name: m.name,
    key: m.key
  }));
}
function isMentionForwardRequest(event, botOpenId) {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }
  const isDirectMessage = event.message.chat_type !== "group";
  const hasOtherMention = mentions.some((m) => m.id.open_id !== botOpenId);
  if (isDirectMessage) {
    return hasOtherMention;
  } else {
    const hasBotMention = mentions.some((m) => m.id.open_id === botOpenId);
    return hasBotMention && hasOtherMention;
  }
}
function extractMessageBody(text, allMentionKeys) {
  let result = text;
  for (const key of allMentionKeys) {
    result = result.replace(new RegExp(escapeRegExp(key), "g"), "");
  }
  return result.replace(/\s+/g, " ").trim();
}
function formatMentionForText(target) {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}
function formatMentionAllForText() {
  return `<at user_id="all">Everyone</at>`;
}
function formatMentionForCard(target) {
  return `<at id=${target.openId}></at>`;
}
function formatMentionAllForCard() {
  return `<at id=all></at>`;
}
function buildMentionedMessage(targets, message) {
  if (targets.length === 0) {
    return message;
  }
  const mentionParts = targets.map((t) => formatMentionForText(t));
  return `${mentionParts.join(" ")} ${message}`;
}
function buildMentionedCardContent(targets, message) {
  if (targets.length === 0) {
    return message;
  }
  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}
export {
  buildMentionedCardContent,
  buildMentionedMessage,
  escapeRegExp,
  extractMentionTargets,
  extractMessageBody,
  formatMentionAllForCard,
  formatMentionAllForText,
  formatMentionForCard,
  formatMentionForText,
  isMentionForwardRequest
};
