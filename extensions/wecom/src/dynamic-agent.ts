/**
 * **Dynamic Agent routing module**
 *
 * Automatically generates a unique Agent ID for each user/group to achieve session isolation.
 * Reference: openclaw-plugin-wecom/dynamic-agent.js
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export interface DynamicAgentConfig {
  enabled: boolean;
  dmCreateAgent: boolean;
  groupEnabled: boolean;
  adminUsers: string[];
}

/**
 * **getDynamicAgentConfig (read dynamic Agent configuration)**
 *
 * Reads the dynamic Agent configuration from the global config, providing default values.
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
  const dynamicAgents = (
    config as { channels?: { wecom?: { dynamicAgents?: Partial<DynamicAgentConfig> } } }
  )?.channels?.wecom?.dynamicAgents;
  return {
    enabled: dynamicAgents?.enabled ?? false,
    dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
    groupEnabled: dynamicAgents?.groupEnabled ?? true,
    adminUsers: dynamicAgents?.adminUsers ?? [],
  };
}

function sanitizeDynamicIdPart(value: string): string {
  return String(value)
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
 */
export function shouldUseDynamicAgent(params: {
  chatType: "dm" | "group";
  senderId: string;
  config: OpenClawConfig;
}): boolean {
  const { chatType, senderId, config } = params;
  const dynamicConfig = getDynamicAgentConfig(config);

  if (!dynamicConfig.enabled) {
    return false;
  }

  // Admins bypass dynamic routing
  const sender = String(senderId).trim().toLowerCase();
  const isAdmin = dynamicConfig.adminUsers.some((admin) => admin.trim().toLowerCase() === sender);
  if (isAdmin) {
    return false;
  }

  if (chatType === "group") {
    return dynamicConfig.groupEnabled;
  }
  return dynamicConfig.dmCreateAgent;
}
