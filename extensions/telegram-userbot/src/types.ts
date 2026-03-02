/**
 * Type definitions for the telegram-userbot channel.
 *
 * These types form the public API surface of the UserbotClient wrapper
 * and are used by downstream tasks (channel adapter, onboarding, etc.).
 */

import type { TelegramClient } from "telegram";
import type { Api } from "telegram/tl/api.js";

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Configuration required to initialize a UserbotClient. */
export type UserbotClientConfig = {
  /** Telegram API ID from my.telegram.org */
  apiId: number;
  /** Telegram API hash from my.telegram.org */
  apiHash: string;
  /** Saved StringSession string. Omit or empty string for new sessions. */
  session?: string;
  /** MTProto connection retry count (default: 5) */
  connectionRetries?: number;
};

/** Callbacks for interactive authentication (first-time login). */
export type InteractiveAuthParams = {
  /** Telegram API ID */
  apiId: number;
  /** Telegram API hash */
  apiHash: string;
  /** Phone number in international format */
  phone: string;
  /** Prompt user for the auth code sent by Telegram */
  codeCallback: () => Promise<string>;
  /** Prompt user for 2FA password (if enabled) */
  passwordCallback?: () => Promise<string>;
};

// ---------------------------------------------------------------------------
// Message operations
// ---------------------------------------------------------------------------

/** Result of a send or edit operation. */
export type SendResult = {
  /** Sent message ID */
  messageId: number;
  /** Timestamp of the message (Unix seconds) */
  date: number;
};

/** Options for sending a text message. */
export type SendMessageOptions = {
  /** Reply to a specific message ID */
  replyTo?: number;
  /** Parse mode for message formatting */
  parseMode?: "html" | "md";
  /** Inline keyboard buttons */
  buttons?: Api.TypeReplyMarkup[];
};

/** Options for sending a file. */
export type SendFileOptions = SendMessageOptions & {
  /** Optional caption text */
  caption?: string;
  /** Force send as document (no auto-conversion to photo/video) */
  forceDocument?: boolean;
  /** Send as voice note */
  voiceNote?: boolean;
};

// ---------------------------------------------------------------------------
// Peer resolution
// ---------------------------------------------------------------------------

/**
 * Peer ID input: numeric ID, @username, bigint, or OpenClaw target format.
 *
 * Accepted formats:
 *  - number: raw Telegram chat/user ID (e.g. 267619672)
 *  - bigint: large Telegram IDs (supergroups/channels)
 *  - string "@username": Telegram username
 *  - string "telegram-userbot:267619672": OpenClaw target format
 *  - string "12345": plain numeric string
 */
export type PeerResolvable = string | number | bigint;

// ---------------------------------------------------------------------------
// Re-exports for downstream typing
// ---------------------------------------------------------------------------

/** Minimal re-export of the raw GramJS client for advanced use. */
export type RawClient = TelegramClient;

/** Resolved message from GramJS. Re-exported for downstream typing. */
export type GramMessage = Api.Message;
