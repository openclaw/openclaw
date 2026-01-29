/**
 * Type definitions for the Claude Agent SDK integration.
 */

import type { MoltbotConfig } from "../../config/config.js";
import type { CcSdkModelTiers } from "../../config/types.agents.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";

/** Provider environment variables for SDK authentication and model config. */
export type SdkProviderEnv = {
  /** Anthropic API key or OAuth token. */
  ANTHROPIC_API_KEY?: string;
  /** OAuth access token (alternative to API key). */
  ANTHROPIC_AUTH_TOKEN?: string;
  /** Custom base URL for API requests. */
  ANTHROPIC_BASE_URL?: string;
  /** Use Bedrock backend. */
  CLAUDE_CODE_USE_BEDROCK?: string;
  /** Use Vertex AI backend. */
  CLAUDE_CODE_USE_VERTEX?: string;
  /** Model for fast/simple tasks (Haiku tier). */
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  /** Model for balanced tasks (Sonnet tier). */
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  /** Model for complex reasoning (Opus tier). */
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  /** API timeout in milliseconds. */
  API_TIMEOUT_MS?: string;
  /** Generic string keys for custom env vars. */
  [key: string]: string | undefined;
};

/** Provider configuration for SDK runner. */
export type SdkProviderConfig = {
  /** Human-readable provider name. */
  name?: string;
  /** Environment variables to set for authentication. */
  env?: SdkProviderEnv;
  /** Model override (if different from config). */
  model?: string;
  /** Max turns before the SDK stops. */
  maxTurns?: number;
};

/**
 * A single conversation turn for SDK history serialization.
 * These are simplified representations of prior Pi Agent messages,
 * stripped of tool results and other internal state.
 */
export type SdkConversationTurn = {
  role: "user" | "assistant";
  content: string;
  /** Optional ISO timestamp for context ordering. */
  timestamp?: string;
};

/** Reasoning/thinking level for the agent. */
export type SdkReasoningLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Verbose output level for tool results. */
export type SdkVerboseLevel = "off" | "on" | "full";

/** Streaming callbacks for SDK runner. */
export type SdkRunnerCallbacks = {
  /** Called when the assistant message starts. */
  onAssistantMessageStart?: () => void | Promise<void>;
  /** Called when a partial reply chunk is available. */
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  /** Called for reasoning/thinking stream events. */
  onReasoningStream?: (payload: { text?: string }) => void | Promise<void>;
  /** Called for block-level reply delivery. */
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
  }) => void | Promise<void>;
  /** Called when block replies should be flushed. */
  onBlockReplyFlush?: () => void | Promise<void>;
  /** Called when a tool result is available. */
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  /** Called for agent lifecycle events. */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

/** Parameters for SDK runner execution. */
export type SdkRunnerParams = {
  // ─── Session & Identity ────────────────────────────────────────────────────
  /** Unique run identifier. */
  runId?: string;
  /** Session identifier. */
  sessionId: string;
  /** Session key for routing. */
  sessionKey?: string;
  /** Path to session file for conversation history. */
  sessionFile: string;
  /** Agent workspace directory. */
  workspaceDir: string;
  /** Agent data directory (for auth profile resolution). */
  agentDir?: string;
  /** Moltbot agent ID (e.g., "main", "work"). */
  agentId?: string;

  // ─── Configuration ─────────────────────────────────────────────────────────
  /** Moltbot configuration. */
  config?: MoltbotConfig;
  /** User prompt/message. */
  prompt: string;
  /** Model to use (provider/model format). */
  model?: string;
  /** Provider configuration. */
  providerConfig?: SdkProviderConfig;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;

  // ─── Model Behavior ────────────────────────────────────────────────────────
  /** Reasoning/thinking level. */
  reasoningLevel?: SdkReasoningLevel;
  /** Verbose level for tool output. */
  verboseLevel?: SdkVerboseLevel;
  /** Maximum output tokens. */
  maxOutputTokens?: number;
  /** Maximum thinking tokens (when reasoning is enabled). */
  maxThinkingTokens?: number;

  // ─── Tools ─────────────────────────────────────────────────────────────────
  /** Allow elevated bash commands. */
  bashElevated?: boolean;
  /** Tools to disable. */
  disableTools?: string[];
  /** Filter for emitting tool results. */
  shouldEmitToolResult?: (toolName: string) => boolean;
  /** Filter for emitting tool output. */
  shouldEmitToolOutput?: (toolName: string) => boolean;

  // ─── System Prompt Context ─────────────────────────────────────────────────
  /** System prompt to prepend / inject. */
  systemPrompt?: string;
  /** Extra system prompt to append. */
  extraSystemPrompt?: string;
  /** User's timezone (e.g., "America/New_York"). */
  timezone?: string;
  /** Messaging channel (e.g., "telegram", "slack"). */
  messageChannel?: string;
  /** Channel-specific hints. */
  channelHints?: string;
  /** Available Moltbot skills (names only, for system prompt context). */
  skills?: string[];
  /** Full formatted skills prompt from skillsSnapshot (preferred over skills). */
  skillsPrompt?: string;
  /** Sender identifier. */
  senderId?: string | null;
  /** Sender display name. */
  senderName?: string | null;
  /** Sender username. */
  senderUsername?: string | null;
  /** Sender E.164 phone number. */
  senderE164?: string | null;

  // ─── SDK Options ───────────────────────────────────────────────────────────
  /** Enable Claude Code hooks. */
  hooksEnabled?: boolean;
  /** Additional SDK options. */
  sdkOptions?: Record<string, unknown>;
  /** 3-tier model configuration (haiku/sonnet/opus). */
  modelTiers?: CcSdkModelTiers;

  /** Thinking level for extended thinking (maps to SDK budgetTokens). */
  thinkingLevel?: ThinkLevel;

  /**
   * Pre-built Moltbot tools to expose to the agent.
   * These should already be policy-filtered.
   */
  tools?: AnyAgentTool[];

  /**
   * Claude Code built-in tools to enable alongside Moltbot MCP tools.
   * Set to `[]` to disable all built-in tools (agent uses only Moltbot tools).
   * Set to `["Read", "Bash", ...]` for a curated list.
   * Defaults to `[]` (Moltbot tools only via MCP).
   */
  builtInTools?: string[];

  /** Permission mode for the SDK ("default", "acceptEdits", "bypassPermissions"). */
  permissionMode?: string;

  /** Max agent turns before the SDK stops. */
  maxTurns?: number;

  // --- Native session resume parameters ---

  /**
   * CCSDK session ID to resume. When provided, the SDK will load
   * conversation history from the specified session instead of
   * injecting history into the system prompt.
   */
  claudeSessionId?: string;

  /**
   * When resuming, fork to a new session ID instead of continuing
   * the previous session. Use with claudeSessionId.
   */
  forkSession?: boolean;

  /**
   * MCP server name for the bridged Moltbot tools.
   * Defaults to "moltbot".
   */
  mcpServerName?: string;

  /**
   * Prior conversation history to serialize into the SDK prompt.
   * Since the SDK is stateless, prior turns are injected as context
   * in the system prompt or user message to simulate multi-turn behavior.
   */
  conversationHistory?: SdkConversationTurn[];
} & SdkRunnerCallbacks;

/** SDK event types from the Claude Agent SDK. */
export type SdkEventType =
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "error"
  | "done"
  | "thinking"
  | "text";

/** Base SDK event structure. */
export type SdkEvent = {
  type: SdkEventType;
  data?: unknown;
};

/** SDK text/content event. */
export type SdkTextEvent = SdkEvent & {
  type: "text" | "assistant_message";
  data: {
    text?: string;
    content?: string;
  };
};

/** SDK tool use event. */
export type SdkToolUseEvent = SdkEvent & {
  type: "tool_use";
  data: {
    name: string;
    input: Record<string, unknown>;
    id?: string;
  };
};

/** SDK tool result event. */
export type SdkToolResultEvent = SdkEvent & {
  type: "tool_result";
  data: {
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  };
};

/** SDK error event. */
export type SdkErrorEvent = SdkEvent & {
  type: "error";
  data: {
    message: string;
    code?: string;
  };
};

/** SDK done event. */
export type SdkDoneEvent = SdkEvent & {
  type: "done";
  data?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

// ---------------------------------------------------------------------------
// SDK runner result types
// ---------------------------------------------------------------------------

/** Error kinds that can occur during SDK execution. */
export type SdkRunnerErrorKind =
  | "sdk_unavailable"
  | "mcp_bridge_failed"
  | "run_failed"
  | "timeout"
  | "no_output";

/** Usage statistics from the SDK execution. */
export type SdkUsageStats = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
};

/** Metadata from an SDK runner execution. */
export type SdkRunnerMeta = {
  durationMs: number;
  provider?: string;
  model?: string;
  eventCount: number;
  extractedChars: number;
  truncated: boolean;
  aborted?: boolean;
  /** Token usage statistics. */
  usage?: SdkUsageStats;
  error?: {
    kind: SdkRunnerErrorKind;
    message: string;
  };
  /** Tool bridge diagnostics. */
  bridge?: {
    toolCount: number;
    registeredTools: string[];
    skippedTools: string[];
  };
};

/** A completed tool call record for session transcript parity. */
export type SdkCompletedToolCall = {
  /** Tool call ID from the model. */
  toolCallId: string;
  /** Normalized tool name. */
  toolName: string;
  /** Tool input arguments. */
  args: Record<string, unknown>;
  /** Tool result text (if completed). */
  result?: string;
  /** Whether the tool execution resulted in an error. */
  isError?: boolean;
};

/** Result from SDK runner execution. */
export type SdkRunnerResult = {
  /** Extracted text payloads from the agent run. */
  payloads: Array<{
    text?: string;
    isError?: boolean;
  }>;
  /** Run metadata. */
  meta: SdkRunnerMeta;
  /** True if a messaging tool successfully sent a message during the run. */
  didSendViaMessagingTool?: boolean;
  /** Texts successfully sent via messaging tools during the run. */
  messagingToolSentTexts?: string[];
  /** Messaging tool targets that successfully sent a message during the run. */
  messagingToolSentTargets?: MessagingToolSend[];
  /** Completed tool calls for session transcript recording. */
  completedToolCalls?: SdkCompletedToolCall[];
  /**
   * CCSDK session ID for the current run. Can be used to resume
   * the session in a future run via the claudeSessionId parameter.
   */
  claudeSessionId?: string;
};
