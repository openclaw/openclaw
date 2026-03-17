import { findGoogleChatDirectMessage } from "./api.js";
function normalizeGoogleChatTarget(raw) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return void 0;
  }
  const withoutPrefix = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "");
  const normalized = withoutPrefix.replace(/^user:(users\/)?/i, "users/").replace(/^space:(spaces\/)?/i, "spaces/");
  if (isGoogleChatUserTarget(normalized)) {
    const suffix = normalized.slice("users/".length);
    return suffix.includes("@") ? `users/${suffix.toLowerCase()}` : normalized;
  }
  if (isGoogleChatSpaceTarget(normalized)) {
    return normalized;
  }
  if (normalized.includes("@")) {
    return `users/${normalized.toLowerCase()}`;
  }
  return normalized;
}
function isGoogleChatUserTarget(value) {
  return value.toLowerCase().startsWith("users/");
}
function isGoogleChatSpaceTarget(value) {
  return value.toLowerCase().startsWith("spaces/");
}
function stripMessageSuffix(target) {
  const index = target.indexOf("/messages/");
  if (index === -1) {
    return target;
  }
  return target.slice(0, index);
}
async function resolveGoogleChatOutboundSpace(params) {
  const normalized = normalizeGoogleChatTarget(params.target);
  if (!normalized) {
    throw new Error("Missing Google Chat target.");
  }
  const base = stripMessageSuffix(normalized);
  if (isGoogleChatSpaceTarget(base)) {
    return base;
  }
  if (isGoogleChatUserTarget(base)) {
    const dm = await findGoogleChatDirectMessage({
      account: params.account,
      userName: base
    });
    if (!dm?.name) {
      throw new Error(`No Google Chat DM found for ${base}`);
    }
    return dm.name;
  }
  return base;
}
export {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSpace
};
