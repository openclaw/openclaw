/**
 * WeCom sub-module configuration type definitions
 *
 * Note: The top-level configuration type WeComConfig is defined in src/utils.ts using a flat structure.
 * This file only defines configuration types for sub-modules such as Network/Media/DynamicAgents.
 */

/** Media processing configuration */
export type WecomMediaConfig = {
  tempDir?: string;
  retentionHours?: number;
  cleanupOnStart?: boolean;
  maxBytes?: number;
};

/** Network configuration */
export type WecomNetworkConfig = {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /**
   * Egress proxy (for scenarios requiring a fixed egress IP for corp trusted IPs).
   * Example: "http://proxy.company.local:3128"
   */
  egressProxyUrl?: string;
};

/** Dynamic Agent configuration */
export type WecomDynamicAgentsConfig = {
  /** Whether to enable dynamic agents */
  enabled?: boolean;
  /** DM: whether to create an independent agent for each user */
  dmCreateAgent?: boolean;
  /** Group chat: whether to enable dynamic agents */
  groupEnabled?: boolean;
  /** Admin user list (bypasses dynamic routing, uses the main agent) */
  adminUsers?: string[];
};
