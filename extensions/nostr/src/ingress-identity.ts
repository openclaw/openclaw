import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizePubkey } from "./nostr-key-utils.js";

export function normalizeNostrAllowEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const accessGroup = parseAccessGroupAllowFromEntry(trimmed);
  if (accessGroup) {
    return `accessGroup:${accessGroup}`;
  }
  try {
    return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
  } catch {
    return null;
  }
}

function normalizeNostrSenderPubkey(value: string): string | null {
  try {
    return normalizePubkey(value);
  } catch {
    return null;
  }
}

export const nostrIngressIdentity = {
  key: "nostr-pubkey",
  // The bus drops every event whose signature does not verify against its pubkey.
  authentication: "verified",
  normalizeEntry: normalizeNostrAllowEntry,
  normalizeSubject: normalizeNostrSenderPubkey,
  sensitivity: "pii",
  entryIdPrefix: "nostr-entry",
} satisfies StableChannelIngressIdentityParams;
