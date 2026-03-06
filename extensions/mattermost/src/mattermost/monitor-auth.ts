import {
  resolveAllowlistMatchSimple,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/mattermost";

export function normalizeMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

export function normalizeMattermostAllowList(entries: Array<string | number>): string[] {
  const normalized = entries
    .map((entry) => normalizeMattermostAllowEntry(String(entry)))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function resolveMattermostEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  return resolveEffectiveAllowFromLists({
    allowFrom: normalizeMattermostAllowList(params.allowFrom ?? []),
    groupAllowFrom: normalizeMattermostAllowList(params.groupAllowFrom ?? []),
    storeAllowFrom: normalizeMattermostAllowList(params.storeAllowFrom ?? []),
    dmPolicy: params.dmPolicy,
  });
}

export function isMattermostSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}): boolean {
  return isMattermostSenderOrChannelAllowed(params);
}

export function isMattermostSenderOrChannelAllowed(params: {
  senderId: string;
  senderName?: string;
  channelId?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}): boolean {
  const allowFrom = normalizeMattermostAllowList(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  const senderMatch = resolveAllowlistMatchSimple({
    allowFrom,
    senderId: normalizeMattermostAllowEntry(params.senderId),
    senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : undefined,
    allowNameMatching: params.allowNameMatching,
  });
  if (senderMatch.allowed) {
    return true;
  }

  const channelId = normalizeMattermostAllowEntry(params.channelId ?? "");
  if (!channelId) {
    return false;
  }

  // Accept either raw channel ids ("abc123") or explicit channel prefixes
  // ("channel:abc123", "mattermost:channel:abc123").
  return (
    allowFrom.includes("*") ||
    allowFrom.includes(channelId) ||
    allowFrom.includes(`channel:${channelId}`) ||
    allowFrom.includes(`group:${channelId}`)
  );
}
