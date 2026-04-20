/**
 * **Dynamic Agent routing module**
 *
 * Automatically generates a unique Agent ID for each user/group to achieve session isolation.
 * Reference: openclaw-plugin-wecom/dynamic-agent.js
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveWeComAccountMulti } from "./accounts.js";

export interface DynamicAgentConfig {
  enabled: boolean;
  dmCreateAgent: boolean;
  groupEnabled: boolean;
  adminUsers: string[];
}

/**
 * **getDynamicAgentConfig (read dynamic Agent configuration)**
 *
 * Reads the dynamic Agent configuration, honoring account-scoped overrides.
 *
 * Resolution order (highest priority last — later wins):
 *   1. Top-level `channels.wecom.dynamicAgents`
 *   2. `channels.wecom.accounts.<accountId>.dynamicAgents` (when an accountId is provided)
 *
 * When `accountId` is omitted, only the top-level config is used (legacy behavior).
 */
export function getDynamicAgentConfig(
  config: OpenClawConfig,
  accountId?: string,
): DynamicAgentConfig {
  // resolveWeComAccountMulti merges top-level + per-account config via the
  // existing mergeWeComAccountConfig helper, so account-level dynamicAgents
  // overrides the top-level one automatically.
  const merged = resolveWeComAccountMulti({ cfg: config, accountId }).config as {
    dynamicAgents?: Partial<DynamicAgentConfig>;
  };
  const dynamicAgents = merged.dynamicAgents;
  return {
    enabled: dynamicAgents?.enabled ?? false,
    dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
    groupEnabled: dynamicAgents?.groupEnabled ?? true,
    adminUsers: dynamicAgents?.adminUsers ?? [],
  };
}

function sanitizeDynamicIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

/**
 * **generateAgentId (generate dynamic Agent ID)**
 *
 * Generates a deterministic Agent ID based on account + chat type + peer ID
 * to prevent cross-account session mixing.
 * Format: wecom-{accountId}-{type}-{sanitizedPeerId}
 */
export function generateAgentId(
  chatType: "dm" | "group",
  peerId: string,
  accountId?: string,
): string {
  const sanitizedPeer = sanitizeDynamicIdPart(peerId) || "unknown";
  const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
  return `wecom-${sanitizedAccountId}-${chatType}-${sanitizedPeer}`;
}

/**
 * **shouldUseDynamicAgent (check whether to use dynamic Agent)**
 *
 * Determines whether a dynamic Agent should be used based on config and sender info.
 * Admins (adminUsers) always bypass dynamic routing and use the main Agent.
 *
 * Pass `accountId` so that per-account `dynamicAgents` overrides are honored.
 */
export function shouldUseDynamicAgent(params: {
  chatType: "dm" | "group";
  senderId: string;
  config: OpenClawConfig;
  accountId?: string;
}): boolean {
  const { chatType, senderId, config, accountId } = params;
  const dynamicConfig = getDynamicAgentConfig(config, accountId);

  if (!dynamicConfig.enabled) {
    return false;
  }

  // Admins bypass dynamic routing
  const sender = senderId.trim().toLowerCase();
  const isAdmin = dynamicConfig.adminUsers.some((admin) => admin.trim().toLowerCase() === sender);
  if (isAdmin) {
    return false;
  }

  if (chatType === "group") {
    return dynamicConfig.groupEnabled;
  }
  return dynamicConfig.dmCreateAgent;
}
