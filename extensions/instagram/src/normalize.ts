import type { InstagramAccountConfig, InstagramGroupConfig, InstagramInboundMessage } from "./types.js";

export function normalizeInstagramUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(instagram|ig|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

export function normalizeInstagramAllowlist(entries?: Array<string | number>): string[] {
  return (entries ?? [])
    .map((entry) => normalizeInstagramUsername(String(entry)))
    .filter(Boolean);
}

export function normalizeInstagramMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^thread:/i.test(trimmed)) {
    const value = trimmed.slice("thread:".length).trim();
    return value ? `thread:${value}` : undefined;
  }
  if (/^(instagram|ig):thread:/i.test(trimmed)) {
    const value = trimmed.replace(/^(instagram|ig):thread:/i, "").trim();
    return value ? `thread:${value}` : undefined;
  }
  if (/^(instagram|ig|user):/i.test(trimmed) || trimmed.startsWith("@")) {
    const username = normalizeInstagramUsername(trimmed);
    return username ? `user:${username}` : undefined;
  }
  if (/^[A-Za-z0-9._]+$/.test(trimmed)) {
    return `user:${trimmed.toLowerCase()}`;
  }
  return undefined;
}

export function looksLikeInstagramTargetId(raw: string): boolean {
  return Boolean(normalizeInstagramMessagingTarget(raw));
}

export function resolveInstagramGroupMatch(params: {
  threadId: string;
  groups?: Record<string, InstagramGroupConfig>;
}): {
  allowed: boolean;
  groupConfig?: InstagramGroupConfig;
  wildcardConfig?: InstagramGroupConfig;
  hasConfiguredGroups: boolean;
} {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const direct = groups[params.threadId];
  if (direct) {
    return {
      allowed: true,
      groupConfig: direct,
      wildcardConfig: groups["*"],
      hasConfiguredGroups,
    };
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return {
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups,
    };
  }
  return {
    allowed: false,
    hasConfiguredGroups,
  };
}

export function resolveInstagramGroupAccessGate(params: {
  groupPolicy: InstagramAccountConfig["groupPolicy"];
  groupMatch: ReturnType<typeof resolveInstagramGroupMatch>;
}): { allowed: boolean; reason: string } {
  const policy = params.groupPolicy ?? "disabled";
  if (policy === "disabled") {
    return { allowed: false, reason: "groupPolicy=disabled" };
  }
  if (policy === "allowlist") {
    if (!params.groupMatch.hasConfiguredGroups) {
      return { allowed: false, reason: "groupPolicy=allowlist and no groups configured" };
    }
    if (!params.groupMatch.allowed) {
      return { allowed: false, reason: "not allowlisted" };
    }
  }
  if (
    params.groupMatch.groupConfig?.enabled === false ||
    params.groupMatch.wildcardConfig?.enabled === false
  ) {
    return { allowed: false, reason: "disabled" };
  }
  return { allowed: true, reason: policy === "open" ? "open" : "allowlisted" };
}

export function resolveInstagramRequireMention(params: {
  groupConfig?: InstagramGroupConfig;
  wildcardConfig?: InstagramGroupConfig;
}): boolean {
  if (params.groupConfig?.requireMention !== undefined) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== undefined) {
    return params.wildcardConfig.requireMention;
  }
  return false;
}

export function resolveInstagramMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  hasControlCommand: boolean;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; reason: string } {
  if (!params.isGroup) {
    return { shouldSkip: false, reason: "direct" };
  }
  if (!params.requireMention) {
    return { shouldSkip: false, reason: "mention-not-required" };
  }
  if (params.wasMentioned) {
    return { shouldSkip: false, reason: "mentioned" };
  }
  if (params.hasControlCommand && params.allowTextCommands && params.commandAuthorized) {
    return { shouldSkip: false, reason: "authorized-command" };
  }
  return { shouldSkip: true, reason: "missing-mention" };
}

export function resolveInstagramAllowlistMatch(params: {
  allowFrom: string[];
  message: InstagramInboundMessage;
}): { allowed: boolean } {
  const allowlist = normalizeInstagramAllowlist(params.allowFrom);
  if (allowlist.includes("*")) {
    return { allowed: true };
  }
  const username = normalizeInstagramUsername(params.message.senderUsername);
  return { allowed: allowlist.includes(username) };
}

export function resolveInstagramGroupSenderAllowed(params: {
  groupPolicy: InstagramAccountConfig["groupPolicy"];
  message: InstagramInboundMessage;
  outerAllowFrom: string[];
  innerAllowFrom: string[];
}): boolean {
  const policy = params.groupPolicy ?? "disabled";
  const inner = normalizeInstagramAllowlist(params.innerAllowFrom);
  const outer = normalizeInstagramAllowlist(params.outerAllowFrom);
  if (inner.length > 0) {
    return resolveInstagramAllowlistMatch({
      allowFrom: inner,
      message: params.message,
    }).allowed;
  }
  if (outer.length > 0) {
    return resolveInstagramAllowlistMatch({
      allowFrom: outer,
      message: params.message,
    }).allowed;
  }
  return policy === "open";
}
