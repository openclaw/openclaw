/**
 * WeCom sub-module configuration type definitions
 *
 * Note: The top-level configuration type WeComConfig is defined in src/utils.ts using a flat structure.
 * This file only defines configuration types for sub-modules such as Agent/Bot/DM/Network/Media.
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

/**
 * Bot mode configuration (smart agent)
 * Used for receiving JSON-format callbacks + streaming replies
 */
export type WecomBotConfig = {
  /** Smart bot ID (for secondary identity confirmation in Matrix mode, webhook mode) */
  aibotid?: string;
  /** Callback Token (generated in WeCom admin console, required for webhook mode) */
  token?: string;
  /** Callback encryption key (generated in WeCom admin console, required for webhook mode) */
  encodingAESKey?: string;
  /**
   * BotId list (optional, used for auditing and alerting).
   * - Callback routing is primarily determined by URL + signature; botIds do not participate in mandatory blocking.
   * - When the decrypted aibotid is not in botIds, only a warning log is recorded.
   */
  botIds?: string[];
  /** Receiver ID (optional, used for decryption validation) */
  receiveId?: string;
  /** Streaming message placeholder */
  streamPlaceholderContent?: string;
  /** Welcome message */
  welcomeText?: string;
  /** DM policy: 'open' allows everyone, 'pairing' requires pairing, 'allowlist' only allows listed users, 'disabled' disables DM */
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  /** Allowed user list; empty means allow everyone */
  allowFrom?: Array<string | number>;

  // --- Long connection mode (WebSocket) ---

  /** Connection mode: webhook (default) or websocket */
  connectionMode?: "webhook" | "websocket";
  /** Bot BotID (required for websocket mode, obtained from WeCom admin console) */
  botId?: string;
  /** Bot Secret (required for websocket mode, obtained from WeCom admin console) */
  secret?: string;
};

/**
 * Agent mode configuration (self-built app)
 * Used for receiving XML-format callbacks + API active sending
 */
export type WecomAgentConfig = {
  /** Corp ID */
  corpId: string;
  /** App Secret */
  corpSecret: string;
  /** App ID (optional; callbacks can be received without it, but active sending requires this field) */
  agentId?: number | string;
  /** Callback Token (from WeCom admin console "Set API Receive") */
  token: string;
  /** Callback encryption key (from WeCom admin console "Set API Receive") */
  encodingAESKey: string;
  /** Welcome message */
  welcomeText?: string;
  /** DM policy: 'open' allows everyone, 'pairing' requires pairing, 'allowlist' only allows listed users, 'disabled' disables DM */
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  /** Allowed user list; empty means allow everyone */
  allowFrom?: Array<string | number>;
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
