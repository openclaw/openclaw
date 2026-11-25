import { defineStableChannelIngressIdentity } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Twitch sets the `user-id` tag on each message it delivers over the OAuth-authenticated chat
// connection; clients cannot set it.
export const twitchUserIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  authentication: "verified",
  entryIdPrefix: "twitch-user-entry",
});

export const twitchRoleIdentity = defineStableChannelIngressIdentity({
  // Roles authorize the sender; only the native user ID identifies the participant.
  key: "sender-id",
  authentication: "verified",
  normalizeEntry: () => null,
  aliases: ["moderator", "owner", "vip", "subscriber"].map((role) => ({
    key: `role-${role}`,
    kind: "role",
    normalizeEntry: (entry) => (normalizeTwitchRole(entry) === role ? role : null),
    normalizeSubject: normalizeTwitchRole,
  })),
  resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`,
});

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  return role === "moderator" || role === "owner" || role === "vip" || role === "subscriber"
    ? role
    : null;
}
