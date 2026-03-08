import type { ChannelGroupContext, GroupToolPolicyConfig } from "openclaw/plugin-sdk/dingtalk";
import type { DingtalkConfig } from "./types.js";

export type DingtalkAllowlistMatch = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: "wildcard" | "id" | "name";
};

export function resolveDingtalkAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): DingtalkAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);

  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = params.senderId.toLowerCase();
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }

  const senderName = params.senderName?.toLowerCase();
  if (senderName && allowFrom.includes(senderName)) {
    return { allowed: true, matchKey: senderName, matchSource: "name" };
  }

  return { allowed: false };
}

export function isDingtalkGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  return resolveDingtalkAllowlistMatch(params).allowed;
}

export function resolveDingtalkGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.dingtalk as DingtalkConfig | undefined;
  if (!cfg) {
    return undefined;
  }
  return undefined;
}

export function resolveDingtalkReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: DingtalkConfig;
}): { requireMention: boolean } {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }
  const requireMention = params.globalConfig?.requireMention ?? true;
  return { requireMention };
}
