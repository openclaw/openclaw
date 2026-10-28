import { defineStableChannelIngressIdentity } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeGoogleChatUserId(raw?: string | null): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

const GOOGLECHAT_EMAIL_KIND = "plugin:googlechat-email" as const;

export const googleChatIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  // Google signs the webhook for the configured audience before sender.name is consumed.
  authentication: "verified",
  normalizeEntry(entry: string): string | null {
    const withoutProvider = normalizeLowercaseStringOrEmpty(entry).replace(
      /^(googlechat|google-chat|gchat):/i,
      "",
    );
    if (!withoutProvider) {
      return null;
    }
    return withoutProvider.startsWith("users/")
      ? normalizeGoogleChatUserId(withoutProvider)
      : withoutProvider;
  },
  normalizeSubject: normalizeGoogleChatUserId,
  aliases: [
    {
      key: "email",
      kind: GOOGLECHAT_EMAIL_KIND,
      normalizeEntry(entry: string): string | null {
        const withoutProvider = normalizeLowercaseStringOrEmpty(entry).replace(
          /^(googlechat|google-chat|gchat):/i,
          "",
        );
        if (withoutProvider.startsWith("users/")) {
          return null;
        }
        return withoutProvider.includes("@") ? withoutProvider : null;
      },
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      authentication: "mutable",
    },
  ],
  isWildcardEntry: (entry) => normalizeLowercaseStringOrEmpty(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    fieldKey === "stableId"
      ? `entry-${entryIndex + 1}:user`
      : `entry-${entryIndex + 1}:${fieldKey}`,
});
