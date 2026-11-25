import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";

export function normalizeLineAllowEntry(value: string | number): string {
  return String(value)
    .trim()
    .replace(/^line:(?:user:)?/i, "");
}

export const lineIngressIdentity = {
  key: "line-user-id",
  // Webhooks are HMAC-checked (X-Line-Signature) before the user id is read.
  authentication: "verified",
  normalize: (value: string) => normalizeLineAllowEntry(value) || null,
  sensitivity: "pii",
  entryIdPrefix: "line-entry",
} satisfies StableChannelIngressIdentityParams;
