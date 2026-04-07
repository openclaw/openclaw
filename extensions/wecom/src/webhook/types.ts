/**
 * Webhook mode type definitions
 *
 * Fully migrated from @mocrane/wecom monitor/types.ts, adapted to the target project's type system.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedWeComAccount } from "../utils.js";

// ============================================================================
// Constants
// ============================================================================

/** StreamState expiration time (10 minutes) */
export const STREAM_TTL_MS = 10 * 60 * 1000;

/** ActiveReply expiration time (1 hour) */
export const ACTIVE_REPLY_TTL_MS = 60 * 60 * 1000;

/** Message debounce interval (500ms) */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Stream reply max bytes (20KB) */
export const STREAM_MAX_BYTES = 20_480;

/** WeCom Bot reply window (6 minutes) */
export const BOT_WINDOW_MS = 6 * 60 * 1000;

/** Timeout safety margin (30 seconds) */
export const BOT_SWITCH_MARGIN_MS = 30_000;

/** HTTP request timeout (15 seconds) */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Auto-cleanup interval (60 seconds) */
export const PRUNE_INTERVAL_MS = 60_000;

/** Fixed Webhook paths */
export const WEBHOOK_PATHS = {
  /** Bot mode legacy compatible path */
  BOT: "/wecom",
  /** Bot mode legacy alternate compatible path */
  BOT_ALT: "/wecom/bot",
  /** Bot mode recommended path prefix */
  BOT_PLUGIN: "/plugins/wecom/bot",
} as const;

// ============================================================================
// Webhook configuration extensions
// ============================================================================

/**
 * Additional account configuration fields for Webhook mode
 */
export interface WebhookAccountConfig {
  /** Connection mode: webhook | websocket (default websocket) */
  connectionMode?: "webhook" | "websocket";
  /** Webhook verification token */
  token?: string;
  /** AES encryption key (43-character Base64) */
  encodingAESKey?: string;
  /** Receiver ID */
  receiveId?: string;
  /** enter_chat welcome message */
  welcomeText?: string;
}

/**
 * Resolved Webhook account info
 * Extends ResolvedWeComAccount with Webhook-specific fields
 */
export interface ResolvedWebhookAccount extends ResolvedWeComAccount {
  connectionMode: "webhook";
  token: string;
  encodingAESKey: string;
  receiveId: string;
  welcomeText?: string;
}

// ============================================================================
// Runtime environment
// ============================================================================

/**
 * Webhook runtime environment
 *
 * Contains basic logging and error reporting interfaces, used to decouple direct dependency on PluginRuntime.
 */
export interface WecomRuntimeEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// ============================================================================
// Webhook Target
// ============================================================================

/**
 * Webhook target context
 *
 * Describes a registered Bot receiving endpoint. Contains all context information needed to handle that endpoint.
 */
export interface WecomWebhookTarget {
  /** Resolved Bot account info (Token, AESKey, etc.) */
  account: ResolvedWebhookAccount;
  /** Plugin global configuration */
  config: OpenClawConfig;
  /** Runtime environment (logging) */
  runtime: WecomRuntimeEnv;
  /** OpenClaw plugin core runtime */
  core: PluginRuntime;
  /** Webhook path registered for this Target */
  path: string;
  /** Report last receive/send time */
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

// ============================================================================
// Stream session state
// ============================================================================

/**
 * Stream session state
 *
 * Records the lifecycle state of a streaming request.
 */
export interface StreamState {
  /** Unique session ID */
  streamId: string;
  /** Associated WeCom message ID (for deduplication) */
  msgid?: string;
  /** Conversation key (same person same conversation, for queue/batch) */
  conversationKey?: string;
  /** Batch key (conversationKey + batch sequence number) */
  batchKey?: string;
  /** Sender userid (for Agent DM fallback) */
  userId?: string;
  /** Conversation type (for group chat fallback logic) */
  chatType?: "group" | "direct";
  /** Group chatid (for logging/prompts, not used for Agent group sends) */
  chatId?: string;
  /** Bot aibotid (for taskKey generation and logging) */
  aibotid?: string;
  /** Bot callback idempotency key (for final delivery idempotency) */
  taskKey?: string;
  /** Creation time */
  createdAt: number;
  /** Last update time (for Prune) */
  updatedAt: number;
  /** Whether processing has started (Agent has taken over) */
  started: boolean;
  /** Whether completed (Agent output finished or error) */
  finished: boolean;
  /** Error message */
  error?: string;
  /** Accumulated response content (for long-polling return) */
  content: string;
  /** Images generated during processing (Base64 + MD5) */
  images?: Array<{ base64: string; md5: string }>;
  /** Fallback mode (internal state only, not exposed to WeCom) */
  fallbackMode?: "media" | "timeout" | "error";
  /** Whether group fallback prompt has been sent (to prevent duplicate messages) */
  fallbackPromptSentAt?: number;
  /** Whether Agent DM final delivery is complete (to prevent duplicate sends) */
  finalDeliveredAt?: number;
  /** Full content for DM fallback (not limited by STREAM_MAX_BYTES, but still needs upper bound protection) */
  dmContent?: string;
  /** Media identifiers already sent via Agent DM (to prevent duplicate attachment sends) */
  agentMediaKeys?: string[];
  /** Whether from WebSocket long connection mode (to skip 6-minute timeout and other webhook-specific logic) */
  wsMode?: boolean;
}

// ============================================================================
// Debounce pending messages
// ============================================================================

/**
 * Webhook inbound message (decrypted JSON format)
 *
 * Field naming aligns with actual JSON structure of WeCom Bot callbacks (consistent with original WecomBotInboundBase):
 * - Sender: `from.userid` (not from.user_id)
 * - Conversation type: `chattype` (flat field, not chat_info.chat_type)
 * - Group chat ID: `chatid` (flat field, not chat_info.chat_id)
 * - Event type: `event.eventtype` (not event.event_type)
 * - Stream ID: `stream.id` (not stream.stream_id)
 */
export interface WebhookInboundMessage {
  msgtype: string;
  msgid?: string;
  /** Bot ID in WeCom Bot callback */
  aibotid?: string;
  /** Conversation type: single | group (flat field) */
  chattype?: "single" | "group";
  /** Group chat ID (flat field, only present in group conversations) */
  chatid?: string;
  /** Attachment count */
  attachment_count?: number;

  text?: { content?: string };
  image?: {
    url?: string;
    aeskey?: string;
    encrypt_file_key?: string;
    file_url?: string;
    base64?: string;
    md5?: string;
  };
  file?: {
    url?: string;
    aeskey?: string;
    encrypt_file_key?: string;
    file_url?: string;
    filename?: string;
    file_name?: string;
    fileName?: string;
  };
  voice?: {
    content?: string;
    url?: string;
    aeskey?: string;
    encrypt_file_key?: string;
    file_url?: string;
  };
  video?: { url?: string; aeskey?: string; encrypt_file_key?: string; file_url?: string };
  mixed?: {
    msg_item: Array<{
      msgtype: string;
      text?: { content?: string };
      image?: {
        url?: string;
        aeskey?: string;
        encrypt_file_key?: string;
        file_url?: string;
        base64?: string;
        md5?: string;
      };
      file?: {
        url?: string;
        aeskey?: string;
        encrypt_file_key?: string;
        file_url?: string;
        filename?: string;
      };
      [key: string]: unknown;
    }>;
  };
  /** Quoted message */
  quote?: WebhookInboundQuote;

  /** Sender (in WeCom Bot callback, userid is from.userid) */
  from?: { userid?: string; corpid?: string };
  /** Event (eventtype, not event_type) */
  event?: {
    eventtype?: string;
    event_key?: string;
    template_card_event?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Stream message */
  stream?: { id?: string };
  /** Downstream reply URL */
  response_url?: string;
}

/**
 * Quoted message structure (aligned with original WecomInboundQuote)
 */
export interface WebhookInboundQuote {
  msgtype?: "text" | "image" | "mixed" | "voice" | "file" | "video";
  text?: { content?: string };
  image?: { url?: string };
  mixed?: {
    msg_item?: Array<{
      msgtype: "text" | "image";
      text?: { content?: string };
      image?: { url?: string };
    }>;
  };
  voice?: { content?: string };
  file?: { url?: string };
  video?: { url?: string };
}

/**
 * Pending / debounced message
 *
 * Message temporarily stored in the queue, waiting for the debounce timer to expire for aggregation.
 */
export interface PendingInbound {
  /** Pre-allocated stream ID */
  streamId: string;
  /** Conversation identifier */
  conversationKey: string;
  /** Batch key */
  batchKey: string;
  /** Target Webhook context */
  target: WecomWebhookTarget;
  /** Original message object (if aggregated, usually refers to the first one) */
  msg: WebhookInboundMessage;
  /** Aggregated message content list */
  contents: string[];
  /** Attached media files (if any) */
  media?: { buffer: Buffer; contentType: string; filename: string };
  /** Aggregated message IDs (for deduplication) */
  msgids: string[];
  /** Callback nonce */
  nonce: string;
  /** Callback timestamp */
  timestamp: string;
  /** Debounce timer handle */
  timeout: ReturnType<typeof setTimeout> | null;
  /** Debounce deadline reached, but held because previous batch is still processing */
  readyToFlush?: boolean;
  /** Creation time */
  createdAt: number;
}

// ============================================================================
// Active reply address state
// ============================================================================

/**
 * Active reply address state
 *
 * Stores the response_url provided in WeCom callbacks, used for subsequent proactive pushes.
 */
export interface ActiveReplyState {
  /** Reply URL provided by WeCom callback */
  response_url: string;
  /** Proxy address if configured */
  proxyUrl?: string;
  /** Creation time */
  createdAt: number;
  /** Usage time (only meaningful when policy="once") */
  usedAt?: number;
  /** Error message from last send failure */
  lastError?: string;
}

// ============================================================================
// Gateway context
// ============================================================================

/**
 * Webhook Gateway context
 */
export interface WebhookGatewayContext {
  account: ResolvedWebhookAccount;
  config: OpenClawConfig;
  /** RuntimeEnv logging environment (from ChannelGatewayContext.runtime) */
  runtime: RuntimeEnv;
  /** PluginRuntime for accessing core features like channel.reply */
  channelRuntime?: PluginRuntime;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
  accountId: string;
}
