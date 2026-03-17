const CHAT_ID_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
function stripProviderPrefix(raw) {
  return raw.replace(/^(feishu|lark):/i, "").trim();
}
function detectIdType(id) {
  const trimmed = id.trim();
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  if (USER_ID_REGEX.test(trimmed)) {
    return "user_id";
  }
  return null;
}
function normalizeFeishuTarget(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = stripProviderPrefix(trimmed);
  const lowered = withoutProvider.toLowerCase();
  if (lowered.startsWith("chat:")) {
    return withoutProvider.slice("chat:".length).trim() || null;
  }
  if (lowered.startsWith("group:")) {
    return withoutProvider.slice("group:".length).trim() || null;
  }
  if (lowered.startsWith("channel:")) {
    return withoutProvider.slice("channel:".length).trim() || null;
  }
  if (lowered.startsWith("user:")) {
    return withoutProvider.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("dm:")) {
    return withoutProvider.slice("dm:".length).trim() || null;
  }
  if (lowered.startsWith("open_id:")) {
    return withoutProvider.slice("open_id:".length).trim() || null;
  }
  return withoutProvider;
}
function formatFeishuTarget(id, type) {
  const trimmed = id.trim();
  if (type === "chat_id" || trimmed.startsWith(CHAT_ID_PREFIX)) {
    return `chat:${trimmed}`;
  }
  if (type === "open_id" || trimmed.startsWith(OPEN_ID_PREFIX)) {
    return `user:${trimmed}`;
  }
  return trimmed;
}
function resolveReceiveIdType(id) {
  const trimmed = id.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("chat:") || lowered.startsWith("group:") || lowered.startsWith("channel:")) {
    return "chat_id";
  }
  if (lowered.startsWith("open_id:")) {
    return "open_id";
  }
  if (lowered.startsWith("user:") || lowered.startsWith("dm:")) {
    const normalized = trimmed.replace(/^(user|dm):/i, "").trim();
    return normalized.startsWith(OPEN_ID_PREFIX) ? "open_id" : "user_id";
  }
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  return "user_id";
}
function looksLikeFeishuId(raw) {
  const trimmed = stripProviderPrefix(raw.trim());
  if (!trimmed) {
    return false;
  }
  if (/^(chat|group|channel|user|dm|open_id):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return true;
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return true;
  }
  return false;
}
export {
  detectIdType,
  formatFeishuTarget,
  looksLikeFeishuId,
  normalizeFeishuTarget,
  resolveReceiveIdType
};
