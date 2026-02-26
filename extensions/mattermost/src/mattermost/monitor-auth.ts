import { resolveAllowlistMatchSimple, resolveEffectiveAllowFromLists } from "openclaw/plugin-sdk";

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
  const allowFrom = params.allowFrom;
  if (allowFrom.length === 0) {
    return false;
  }
  const match = resolveAllowlistMatchSimple({
    allowFrom,
    senderId: normalizeMattermostAllowEntry(params.senderId),
    senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : undefined,
    allowNameMatching: params.allowNameMatching,
  });
  return match.allowed;
}
