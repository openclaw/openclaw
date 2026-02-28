import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";
import { normalizeWeComTarget } from "./targets.js";
import type { WeComConfig, WeComGroupConfig } from "./types.js";

export type WeComAllowlistMatch = AllowlistMatch<"wildcard" | "id">;

function normalizeWeComAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  const withoutProviderPrefix = trimmed.replace(/^wecom:/i, "");
  const normalized = normalizeWeComTarget(withoutProviderPrefix) ?? withoutProviderPrefix;
  return normalized.trim().toLowerCase();
}

export function resolveWeComAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): WeComAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => normalizeWeComAllowEntry(String(entry)))
    .filter(Boolean);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  // WeCom allowlists are ID-based
  const senderCandidates = [params.senderId, ...(params.senderIds ?? [])]
    .map((entry) => normalizeWeComAllowEntry(String(entry ?? "")))
    .filter(Boolean);

  for (const senderId of senderCandidates) {
    if (allowFrom.includes(senderId)) {
      return { allowed: true, matchKey: senderId, matchSource: "id" };
    }
  }

  return { allowed: false };
}

export function resolveWeComGroupConfig(params: {
  cfg?: WeComConfig;
  groupId?: string | null;
}): WeComGroupConfig | undefined {
  // WeCom doesn't have per-group config yet, return undefined
  return undefined;
}

export function resolveWeComGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.wecom as WeComConfig | undefined;
  if (!cfg) {
    return undefined;
  }

  const groupConfig = resolveWeComGroupConfig({
    cfg,
    groupId: params.groupId,
  });

  return groupConfig?.tools;
}

export function isWeComGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  return resolveWeComAllowlistMatch(params).allowed;
}

export function resolveWeComReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: WeComConfig;
  groupConfig?: WeComGroupConfig;
}): { requireMention: boolean } {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }

  const requireMention =
    params.groupConfig?.requireMention ?? params.globalConfig?.requireMention ?? false;

  return { requireMention };
}
