/**
 * Types for the Claude Agent SDK runner — an alternative to the Pi Agent
 * embedded runner that uses the Claude Agent SDK as the main agent runtime.
 */

import type { ClawdbrainConfig } from "../../config/config.js";
import type { AnyAgentTool } from "../tools/common.js";

// ---------------------------------------------------------------------------
// SDK provider configuration (z.AI, Anthropic, or custom)
// ---------------------------------------------------------------------------

/**
 * Environment variable overrides for a Claude Agent SDK provider.
 *
 * These are passed to `query({ options: { env } })` and control which
 * backend the SDK talks to. For z.AI, this includes the base URL, auth
 * token, and timeout. For Anthropic (default), this is empty/undefined.
 */
export type SdkProviderEnv = {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  API_TIMEOUT_MS?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  [key: string]: string | undefined;
};

/** Configuration for a single Claude Agent SDK provider backend. */
export type SdkProviderConfig = {
  /** Display name for logging/status. */
  name?: string;
  /** Environment variable overrides for this provider. */
  env?: SdkProviderEnv;
  /** Override the model alias (e.g., "sonnet", "opus"). */
  model?: string;
  /** Max turns before the SDK stops. */
  maxTurns?: number;
};

// ---------------------------------------------------------------------------
// SDK runner params (analogous to RunEmbeddedPiAgentParams)
// ---------------------------------------------------------------------------

export type SdkRunnerParams = {
  /** Unique run identifier. */
  runId: string;

  /** Session identifier (used for logging and tracking). */
  sessionId: string;

  /** The user prompt to send to the agent. */
  prompt: string;

  /** Working directory for the agent. */
  workspaceDir: string;

  /** Agent directory (for auth profile resolution). */
  agentDir?: string;

  /** Clawdbrain configuration (for tool creation, policies, etc.). */
  config?: ClawdbrainConfig;

  /**
   * Pre-built Clawdbrain tools to expose to the agent.
   * These should already be policy-filtered (via createClawdbrainCodingTools).
   */
  tools: AnyAgentTool[];

  /**
   * SDK provider configuration. Controls which backend the SDK talks to.
   * - undefined → default Anthropic (local Claude Code auth)
   * - { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/..." } } → z.AI
   */
  provider?: SdkProviderConfig;

  /**
   * Claude Code built-in tools to enable alongside Clawdbrain MCP tools.
   * Set to `[]` to disable all built-in tools (agent uses only Clawdbrain tools).
   * Set to `["Read", "Bash", ...]` for a curated list.
   * Defaults to `[]` (Clawdbrain tools only via MCP).
   */
  builtInTools?: string[];

  /** System prompt to prepend / inject. */
  systemPrompt?: string;

  /** Permission mode for the SDK ("default", "acceptEdits", "bypassPermissions"). */
  permissionMode?: string;

  /** Enable Claude Code hook wiring for richer lifecycle/tool parity. */
  hooksEnabled?: boolean;

  /** Additional `query({ options })` fields to pass through (excluding tool bridging). */
  sdkOptions?: Record<string, unknown>;

  /** Max agent turns before the SDK stops. */
  maxTurns?: number;

  /** Timeout in milliseconds for the entire run. */
  timeoutMs?: number;

  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;

  // --- Streaming callbacks (subset of RunEmbeddedPiAgentParams) ---

  /** Called with partial text as the agent streams a response. */
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;

  /** Called when the agent starts a new assistant message. */
  onAssistantMessageStart?: () => void | Promise<void>;

  /** Called when the agent completes a block reply. */
  onBlockReply?: (payload: { text?: string }) => void | Promise<void>;

  /** Called when a tool result is produced. */
  onToolResult?: (payload: { text?: string }) => void | Promise<void>;

  /** Called for lifecycle / diagnostic events. */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;

  /**
   * MCP server name for the bridged Clawdbrain tools.
   * Defaults to "clawdbrain".
   */
  mcpServerName?: string;

  /**
   * Prior conversation history to serialize into the SDK prompt.
   * Since the SDK is stateless, prior turns are injected as context
   * in the system prompt or user message to simulate multi-turn behavior.
   */
  conversationHistory?: SdkConversationTurn[];
};

// ---------------------------------------------------------------------------
// Conversation history types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SDK runner result (analogous to EmbeddedPiRunResult)
// ---------------------------------------------------------------------------

export type SdkRunnerMeta = {
  durationMs: number;
  provider?: string;
  model?: string;
  eventCount: number;
  extractedChars: number;
  truncated: boolean;
  aborted?: boolean;
  error?: {
    kind: "sdk_unavailable" | "mcp_bridge_failed" | "run_failed" | "timeout" | "no_output";
    message: string;
  };
  /** Tool bridge diagnostics. */
  bridge?: {
    toolCount: number;
    registeredTools: string[];
    skippedTools: string[];
  };
};

export type SdkRunnerResult = {
  /** Extracted text payloads from the agent run. */
  payloads: Array<{
    text?: string;
    isError?: boolean;
  }>;
  /** Run metadata. */
  meta: SdkRunnerMeta;
};
