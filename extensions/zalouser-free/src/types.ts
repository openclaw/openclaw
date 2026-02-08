/**
 * Type definitions for zalouser-free channel plugin
 */

import type { API, Credentials } from "zca-js";

// ============================================================================
// Account Configuration Types
// ============================================================================

export interface ZaloUserFreeAccountConfig {
  /** Account identifier (user-defined) */
  accountId: string;
  /** Enable/disable this account */
  enabled: boolean;
  /** Display name for this account */
  displayName?: string;
  /** DM access control: 'open' (anyone) or 'whitelist' (only allowed users) */
  dmAccess?: "open" | "whitelist";
  /** Group access control: 'open' (anyone) or 'whitelist' (only allowed groups) */
  groupAccess?: "open" | "whitelist";
  /** Group reply mode: 'mention' (only reply when mentioned) or 'all' (reply to all messages) */
  groupReplyMode?: "mention" | "all";
  /** List of allowed user IDs (for whitelist modes) */
  allowedUsers?: string[];
  /** List of allowed group IDs (for whitelist modes) */
  allowedGroups?: string[];
}

export interface ZaloUserFreeChannelConfig {
  enabled?: boolean;
  accounts?: Record<string, ZaloUserFreeAccountConfig>;
  defaultAccount?: string;
}

export interface ZaloUserFreePluginConfig {
  /** Polling interval for message listener in milliseconds */
  pollIntervalMs?: number;
  /** Path to store session credentials */
  sessionPath?: string;
  /** Path to save QR code image during login */
  qrOutputPath?: string;
}

// ============================================================================
// Session Types
// ============================================================================

export interface ZaloSession {
  accountId: string;
  api: API;
  credentials: Credentials;
  userId: string;
  displayName?: string;
  isListening: boolean;
  startedAt: number;
}

export interface SessionStore {
  [accountId: string]: {
    credentials: Credentials;
    userId: string;
    lastLogin: number;
  };
}

// ============================================================================
// Message Types
// ============================================================================

export type ChatType = "direct" | "group";

export interface IncomingMessage {
  messageId: string;
  threadId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  text?: string;
  timestamp: number;
  isSelf: boolean;
  mentions?: Array<{ userId: string; offset: number; length: number }>;
  raw?: unknown;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface StatusResult {
  accountId: string;
  connected: boolean;
  userId?: string;
  displayName?: string;
  isListening: boolean;
  uptime?: number;
}
