import { getMatrixRuntime } from "../../runtime.js";
function checkFormattedBodyMention(formattedBody, userId) {
  if (!formattedBody || !userId) {
    return false;
  }
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plainPattern = new RegExp(`href=["']https://matrix\\.to/#/${escapedUserId}["']`, "i");
  if (plainPattern.test(formattedBody)) {
    return true;
  }
  const encodedUserId = encodeURIComponent(userId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const encodedPattern = new RegExp(`href=["']https://matrix\\.to/#/${encodedUserId}["']`, "i");
  return encodedPattern.test(formattedBody);
}
function resolveMentions(params) {
  const mentions = params.content["m.mentions"];
  const mentionedUsers = Array.isArray(mentions?.user_ids) ? new Set(mentions.user_ids) : /* @__PURE__ */ new Set();
  const mentionedInFormattedBody = params.userId ? checkFormattedBodyMention(params.content.formatted_body, params.userId) : false;
  const wasMentioned = Boolean(mentions?.room) || (params.userId ? mentionedUsers.has(params.userId) : false) || mentionedInFormattedBody || getMatrixRuntime().channel.mentions.matchesMentionPatterns(
    params.text ?? "",
    params.mentionRegexes
  );
  return { wasMentioned, hasExplicitMention: Boolean(mentions) };
}
export {
  resolveMentions
};
