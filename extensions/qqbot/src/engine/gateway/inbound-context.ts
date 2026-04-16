/**
 * InboundContext — the structured result of the inbound pipeline.
 *
 * Connects the inbound stage (content building, attachment processing,
 * quote resolution) with the outbound stage (AI dispatch, deliver callbacks).
 *
 * All fields are readonly after construction. The outbound dispatcher
 * reads from this object but never mutates it.
 */

import type { QueuedMessage } from "./message-queue.js";
import type {
  GatewayAccount,
  GatewayLogger,
  GatewayPluginRuntime,
  ProcessedAttachments,
} from "./types.js";
import type { TypingKeepAlive } from "./typing-keepalive.js";

// ============ InboundContext ============

/** Quote (reply-to) metadata resolved during inbound processing. */
export interface ReplyToInfo {
  id: string;
  body?: string;
  sender?: string;
  isQuote: boolean;
}

/** Fully resolved inbound context passed to the outbound dispatcher. */
export interface InboundContext {
  // ---- Original event ----
  event: QueuedMessage;

  // ---- Routing ----
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  /** Fully qualified target address: "qqbot:c2c:xxx" / "qqbot:group:xxx" etc. */
  qualifiedTarget: string;
  fromAddress: string;

  // ---- Content ----
  /** event.content after parseFaceTags. */
  parsedContent: string;
  /** parsedContent + voiceText + attachmentInfo — the user-visible text. */
  userContent: string;
  /** "[Quoted message begins]…[ends]" or empty. */
  quotePart: string;
  /** Per-message dynamic metadata lines (images, voice, ASR). */
  dynamicCtx: string;
  /** quotePart + userContent. */
  userMessage: string;
  /** dynamicCtx + userMessage (or raw content for slash commands). */
  agentBody: string;
  /** Formatted inbound envelope (Web UI body). */
  body: string;

  // ---- System prompts ----
  systemPrompts: string[];
  groupSystemPrompt?: string;

  // ---- Attachments ----
  attachments: ProcessedAttachments;
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];

  // ---- Voice ----
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
  hasAsrReferFallback: boolean;
  voiceTranscriptSources: string[];

  // ---- Reply-to / Quote ----
  replyTo?: ReplyToInfo;

  // ---- Auth ----
  commandAuthorized: boolean;

  // ---- Typing ----
  typing: { keepAlive: TypingKeepAlive | null };
  /** refIdx returned by the initial InputNotify call. */
  inputNotifyRefIdx?: string;
}

// ============ Pipeline dependencies ============

/** Dependencies injected into the inbound pipeline. */
export interface InboundPipelineDeps {
  account: GatewayAccount;
  cfg: unknown;
  log?: GatewayLogger;
  runtime: GatewayPluginRuntime;
  /** Start typing indicator and return the refIdx from InputNotify. */
  startTyping: (event: QueuedMessage) => Promise<{
    refIdx?: string;
    keepAlive: TypingKeepAlive | null;
  }>;
}
