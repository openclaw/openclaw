/**
 * WeCom group access control module
 *
 * Handles group policy checks (groupPolicy, group allowlist, per-group sender allowlist).
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID } from "./const.js";
import type { ResolvedWeComAccount, WeComConfig, WeComGroupConfig } from "./utils.js";

interface GroupPolicyRuntime {
  log?: (message: string) => void;
}

// ============================================================================
// Check result types
// ============================================================================

/**
 * Group policy check result
 */
export interface GroupPolicyCheckResult {
  /** Whether the message is allowed to proceed */
  allowed: boolean;
}

// ============================================================================
// Internal helper functions
// ============================================================================

/**
 * Resolve WeCom group configuration
 */
function resolveWeComGroupConfig(params: {
  cfg?: WeComConfig;
  groupId?: string | null;
}): WeComGroupConfig | undefined {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return undefined;
  }

  const direct = groups[groupId];
  if (direct) {
    return direct;
  }

  const lowered = groupId.toLowerCase();
  const matchKey = Object.keys(groups).find((key) => key.toLowerCase() === lowered);
  if (matchKey) {
    return groups[matchKey];
  }
  return wildcard;
}

/**
 * Check whether the group is in the allow list
 */
function isWeComGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: Array<string | number>;
  groupId: string;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  // Allowlist mode: check if the group is in the allow list
  const normalizedAllowFrom = params.allowFrom.map((entry) =>
    String(entry)
      .replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "")
      .trim(),
  );
  if (normalizedAllowFrom.includes("*")) {
    return true;
  }
  const normalizedGroupId = params.groupId.trim();
  return normalizedAllowFrom.some(
    (entry) =>
      entry === normalizedGroupId || entry.toLowerCase() === normalizedGroupId.toLowerCase(),
  );
}

/**
 * Check whether the sender within a group is in the allow list
 */
function isGroupSenderAllowed(params: {
  senderId: string;
  groupId: string;
  wecomConfig: WeComConfig;
}): boolean {
  const { senderId, groupId, wecomConfig } = params;

  const groupConfig = resolveWeComGroupConfig({
    cfg: wecomConfig,
    groupId,
  });

  const perGroupSenderAllowFrom = (groupConfig?.allowFrom ?? []).map((v) => String(v));

  if (perGroupSenderAllowFrom.length === 0) {
    return true;
  }

  if (perGroupSenderAllowFrom.includes("*")) {
    return true;
  }

  return perGroupSenderAllowFrom.some((entry) => {
    const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
    return normalized === senderId || normalized === `user:${senderId}`;
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check group policy access control.
 * @returns Check result indicating whether processing should continue
 */
export function checkGroupPolicy(params: {
  chatId: string;
  senderId: string;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: GroupPolicyRuntime;
}): GroupPolicyCheckResult {
  const { chatId, senderId, account, config, runtime } = params;
  // Use account.config (already merged for multi-account), not top-level config.channels.wecom
  // Prevents missing account-level groupAllowFrom / groups in multi-account mode
  const wecomConfig = account.config;

  // Honor channels.defaults.groupPolicy as fallback (aligned with Discord, Slack, etc.)
  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy as
    | "open"
    | "allowlist"
    | "disabled"
    | undefined;
  const groupPolicy = wecomConfig.groupPolicy ?? defaultGroupPolicy ?? "open";

  const groupAllowFrom = wecomConfig.groupAllowFrom ?? [];
  const groupAllowed = isWeComGroupAllowed({
    groupPolicy,
    allowFrom: groupAllowFrom,
    groupId: chatId,
  });

  if (!groupAllowed) {
    runtime.log?.(`[WeCom] Group ${chatId} not allowed (groupPolicy=${groupPolicy})`);
    return { allowed: false };
  }

  const senderAllowed = isGroupSenderAllowed({
    senderId,
    groupId: chatId,
    wecomConfig,
  });

  if (!senderAllowed) {
    runtime.log?.(`[WeCom] Sender ${senderId} not in group ${chatId} sender allowlist`);
    return { allowed: false };
  }

  return { allowed: true };
}

/**
 * Check whether the sender is in the allow list (general purpose)
 */
export function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  return allowFrom.some((entry) => {
    const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
    return normalized === senderId || normalized === `user:${senderId}`;
  });
}
