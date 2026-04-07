/**
 * WeCom account type definitions
 */

import type { WecomAgentConfig, WecomNetworkConfig } from "./config.js";

/**
 * Resolved Agent account
 */
export type ResolvedAgentAccount = {
  /** Account ID */
  accountId: string;
  /** Whether enabled */
  enabled: boolean;
  /** Whether fully configured */
  configured: boolean;
  /** Corp ID */
  corpId: string;
  /** App Secret */
  corpSecret: string;
  /** App ID (numeric, optional) */
  agentId?: number;
  /** Callback Token */
  token: string;
  /** Callback encryption key */
  encodingAESKey: string;
  /** Original configuration */
  config: WecomAgentConfig;
  /** Network configuration (from channels.wecom.network) */
  network?: WecomNetworkConfig;
};
