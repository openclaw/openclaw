import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/feishu";
import { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/feishu";
import { normalizeFeishuTarget } from "./targets.js";
import type { FeishuConfig, FeishuGroupConfig } from "./types.js";

export type FeishuAllowlistMatch = AllowlistMatch<"wildcard" | "id">;

function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  const withoutProviderPrefix = trimmed.replace(/^feishu:/i, "");
  const normalized = normalizeFeishuTarget(withoutProviderPrefix) ?? withoutProviderPrefix;
  return normalized.trim().toLowerCase();
}

/**
 * Normalize group ID to handle both 'group:xxx' and 'xxx' formats
 * This ensures consistent matching between binding configuration and incoming messages
 */
function normalizeGroupId(groupId: string | null | undefined): string | undefined {
  if (!groupId) {
    return undefined;
  }
  // Use normalizeFeishuTarget to strip group: prefix if present
  const normalized = normalizeFeishuTarget(groupId);
  return normalized?.trim().toLowerCase();
}

export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): FeishuAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => normalizeFeishuAllowEntry(String(entry)))
    .filter(Boolean);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  // Feishu allowlists are ID-based; mutable display names must never grant access.
  const senderCandidates = [params.senderId, ...(params.senderIds ?? [])]
    .map((entry) => normalizeFeishuAllowEntry(String(entry ?? "")))
    .filter(Boolean);

  for (const senderId of senderCandidates) {
    if (allowFrom.includes(senderId)) {
      return { allowed: true, matchKey: senderId, matchSource: "id" };
    }
  }

  return { allowed: false };
}

export function resolveFeishuGroupConfig(params: {
  cfg?: FeishuConfig;
  groupId?: string | null;
}): FeishuGroupConfig | undefined {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return undefined;
  }

  // Try direct match first
  const direct = groups[groupId];
  if (direct) {
    return direct;
  }

  // Normalize the group ID to handle both 'group:xxx' and 'xxx' formats
  const normalizedGroupId = normalizeGroupId(groupId);
  if (!normalizedGroupId) {
    return wildcard;
  }

  // Try normalized match
  const normalizedMatch = groups[normalizedGroupId];
  if (normalizedMatch) {
    return normalizedMatch;
  }

  // Try case-insensitive match on normalized ID
  const lowered = normalizedGroupId.toLowerCase();
  const matchKey = Object.keys(groups).find((key) => {
    const normalizedKey = normalizeGroupId(key);
    return normalizedKey?.toLowerCase() === lowered;
  });
  if (matchKey) {
    return groups[matchKey];
  }

  return wildcard;
}

export function resolveFeishuGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
  if (!cfg) {
    return undefined;
  }

  const groupConfig = resolveFeishuGroupConfig({
    cfg,
    groupId: params.groupId,
  });

  return groupConfig?.tools;
}

export function isFeishuGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled" | "allowall";
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): boolean {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy === "allowall" ? "open" : params.groupPolicy,
    groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
    senderId: params.senderId,
    isSenderAllowed: () => resolveFeishuAllowlistMatch(params).allowed,
  }).allowed;
}

export function resolveFeishuReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: FeishuConfig;
  groupConfig?: FeishuGroupConfig;
}): { requireMention: boolean } {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }

  const requireMention =
    params.groupConfig?.requireMention ?? params.globalConfig?.requireMention ?? true;

  return { requireMention };
}
