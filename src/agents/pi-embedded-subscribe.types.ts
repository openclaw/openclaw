import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

export type ToolResultFormat = "markdown" | "plain";

export type SubscribeEmbeddedPiSessionParams = {
  session: AgentSession;
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  verboseLevel?: VerboseLevel;
  reasoningMode?: ReasoningLevel;
  /**
   * When true, reasoning/thinking text is prefixed to block replies (italicized with separator)
   * instead of being emitted via onReasoningStream. This is useful for surfaces that want
   * reasoning visible inline but don't support separate reasoning streams.
   *
   * When false or undefined, reasoning is only emitted via onReasoningStream (if provided).
   * Channels should NOT set this to true - they should leave it undefined/false.
   */
  emitReasoningInBlockReply?: boolean;
  toolResultFormat?: ToolResultFormat;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }) => void | Promise<void>;
  /** Flush pending block replies (e.g., before tool execution to preserve message boundaries). */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  enforceFinalTag?: boolean;
};

export type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
