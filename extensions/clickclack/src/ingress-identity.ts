import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";

export function normalizeClickClackUserId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = trimmed.replace(/^(clickclack|cc):/i, "").trim();
  const directTarget = withoutProvider.match(/^dm:(.+)$/i);
  return directTarget?.[1]?.trim() || withoutProvider || null;
}

export const clickClackIngressIdentity = {
  key: "user-id",
  // The author id comes from the server's own copy of the message, re-fetched with the bot
  // token; the pushed event is only a routing hint.
  authentication: "verified",
  normalizeEntry: normalizeClickClackUserId,
  normalizeSubject: normalizeClickClackUserId,
  isWildcardEntry: (entry) => normalizeClickClackUserId(entry) === "*",
  entryIdPrefix: "clickclack-user",
} satisfies StableChannelIngressIdentityParams;
