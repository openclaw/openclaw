import { randomUUID } from "node:crypto";
function normalizeTwitchChannel(channel) {
  const trimmed = channel.trim().toLowerCase();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}
function missingTargetError(provider, hint) {
  return new Error(`Delivering to ${provider} requires target${hint ? ` ${hint}` : ""}`);
}
function generateMessageId() {
  return `${Date.now()}-${randomUUID()}`;
}
function normalizeToken(token) {
  return token.startsWith("oauth:") ? token.slice(6) : token;
}
function isAccountConfigured(account, resolvedToken) {
  const token = resolvedToken ?? account?.accessToken;
  return Boolean(account?.username && token && account?.clientId);
}
export {
  generateMessageId,
  isAccountConfigured,
  missingTargetError,
  normalizeToken,
  normalizeTwitchChannel
};
