import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClaudeSdkConfig } from "../../config/zod-schema.agent-runtime.js";
import type { ModelCostConfig } from "../../utils/usage-format.js";
import type { AgentRuntimeSession, AgentRuntimeHints } from "../agent-runtime.js";
import type { ResolvedProviderAuth } from "../model-auth.js";
import type { EmbeddedPiSubscribeEvent } from "../pi-embedded-subscribe.handlers.types.js";

// ---------------------------------------------------------------------------
// Minimal tool interface compatible with both AnyAgentTool (4-param execute)
// and ToolDefinition from @mariozechner/pi-coding-agent (5-param execute with
// ExtensionContext). The MCP tool server only uses name, description,
// parameters, and execute — so we avoid importing either full type here.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClaudeSdkCompatibleTool = {
  name: string;
  description?: string | null;
  parameters: Record<string, unknown> | { [key: symbol]: unknown };
  ownerOnly?: boolean;
  execute: AgentTool["execute"] | ToolDefinition["execute"];
};

// ---------------------------------------------------------------------------
// Session creation params — passed from attempt.ts to createClaudeSdkSession()
// ---------------------------------------------------------------------------

export type ClaudeSdkSessionParams = {
  workspaceDir: string;
  agentDir?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  runId?: string;
  attemptNumber?: number;
  diagnosticsEnabled?: boolean;
  modelId: string;
  provider?: string;
  tools: ClaudeSdkCompatibleTool[];
  customTools: ClaudeSdkCompatibleTool[];
  systemPrompt: string;
  modelCost?: ModelCostConfig;
  thinkLevel?: string;
  extraParams?: Record<string, unknown>;
  /** Additional MCP servers to expose to the Claude Agent SDK alongside the
   *  built-in "openclaw-tools" bridge. Keyed by server name. If a caller
   *  includes "openclaw-tools" here it will be overwritten by the internal bridge. */
  mcpServers?: Record<string, unknown>;
  /** Claude Agent SDK session ID to resume. Loaded from SessionManager custom entry. */
  claudeSdkResumeSessionId?: string;
  /** Resolved claudeSdk options from agents config. */
  claudeSdkConfig?: ClaudeSdkConfig;
  /** Full auth-resolution output (profile/source/mode/key) for provider env mapping. */
  resolvedProviderAuth?: ResolvedProviderAuth;
  /** SessionManager instance for persisting the claude SDK session ID and messages. */
  sessionManager?: {
    appendCustomEntry?: (key: string, value: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appendMessage?: (message: any) => string;
  };
};

// ---------------------------------------------------------------------------
// Session interface — duck-typed to match Pi's AgentSession surface
// ---------------------------------------------------------------------------

export type ClaudeSdkSession = AgentRuntimeSession & {
  /** Claude Agent SDK server-side session ID, set after first prompt. */
  readonly claudeSdkSessionId: string | undefined;
  /** Latest observed SDK lifecycle signals (for retry policy and diagnostics). */
  readonly claudeSdkLifecycleSnapshot:
    | {
        sdkStatus: "compacting" | null | undefined;
        compactBoundaryCount: number;
        statusCompactingCount: number;
        statusIdleCount: number;
        lastAuthStatus?: {
          isAuthenticating: boolean;
          error?: string;
          output?: string[];
        };
        lastHookEvent?: {
          subtype: "hook_started" | "hook_progress" | "hook_response";
          hookId?: string;
          hookName?: string;
          hookEvent?: string;
          outcome?: string;
        };
        lastTaskEvent?: {
          subtype: "task_started" | "task_progress" | "task_notification";
          taskId?: string;
          status?: string;
          description?: string;
        };
        lastRateLimitInfo?: unknown;
        lastPromptSuggestion?: string;
      }
    | undefined;
};

// Re-export for use in create-session.ts without an additional import
export type { AgentRuntimeHints };

// ---------------------------------------------------------------------------
// Internal event adapter state
// ---------------------------------------------------------------------------

export type ClaudeSdkEventAdapterState = {
  subscribers: Array<(evt: EmbeddedPiSubscribeEvent) => void>;
  streaming: boolean;
  compacting: boolean;
  pendingCompactionEnd:
    | {
        willRetry: boolean;
        pre_tokens: number | undefined;
        trigger: "manual" | "auto" | undefined;
      }
    | undefined;
  abortController: AbortController | null;
  systemPrompt: string;
  pendingSteer: string[];
  pendingToolUses: Array<{ id: string; name: string; input: unknown }>;
  toolNameByUseId: Map<string, string>;
  messages: AgentMessage[];
  messageIdCounter: number;
  streamingMessageId: string | null;
  claudeSdkSessionId: string | undefined;
  /** True once dispose() has persisted the session ID to avoid duplicate entries. */
  sessionIdPersisted?: boolean;
  /** Set when the SDK yields a result message with an error subtype. The
   *  prompt() method throws this after the for-await loop so callers receive
   *  a proper rejection rather than a silent successful resolution. */
  sdkResultError: string | undefined;
  /** Last stderr output captured from the Claude Code subprocess.
   *  Attached to process-exit errors for actionable diagnostics. */
  lastStderr: string | undefined;
  /** Maps content_block_start index to block type so content_block_stop knows what to emit. */
  streamingBlockTypes: Map<number, string>;
  /** Accumulated partial message built up during streaming, used as `message` field in Pi events. */
  streamingPartialMessage: {
    role: "assistant";
    content: unknown[];
    usage?: unknown;
    model?: string;
    stop_reason?: string;
  } | null;
  /** Set true on stream message_start; used by assistant handler to skip re-emitting events. */
  streamingInProgress: boolean;
  /** SessionManager reference for JSONL persistence. */
  sessionManager?: {
    appendCustomEntry?: (key: string, value: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appendMessage?: (message: any) => string;
  };
  transcriptProvider: string;
  transcriptApi: string;
  modelCost?: ModelCostConfig;
  /** Last SDK status value from system/status events. */
  sdkStatus?: "compacting" | null;
  /** Number of compact_boundary lifecycle events observed this session. */
  compactBoundaryCount?: number;
  /** Number of status=compacting lifecycle events observed this session. */
  statusCompactingCount?: number;
  /** Number of status=null lifecycle events observed this session. */
  statusIdleCount?: number;
  /** Last permission mode reported by the SDK system/status event. */
  sdkPermissionMode?: string;
  /** Tracks replayed user message UUIDs emitted by SDK dedupe acknowledgements. */
  replayedUserMessageUuids?: Set<string>;
  /** Tracks files confirmed as persisted by system/files_persisted events. */
  persistedFileIdsByName?: Map<string, string>;
  /** Tracks file persistence failures from system/files_persisted events. */
  failedPersistedFilesByName?: Map<string, string>;
  /** Ordered files_persisted success events (used for hash->file_id reconciliation). */
  persistedFileEvents?: Array<{ filename?: string; fileId: string; observedAt: number }>;
  /** Ordered files_persisted failure events (used for retry/fallback decisions). */
  failedPersistedFileEvents?: Array<{ filename?: string; error: string; observedAt: number }>;
  /** Hash->persisted file metadata for send-path reuse in this runtime session. */
  mediaReferencesByHash?: Map<
    string,
    {
      fileId: string;
      filename: string;
      sessionId?: string;
      provider?: string;
      modelId?: string;
      updatedAt: number;
    }
  >;
  /** Filename->persisted file metadata for hashless/legacy recovery paths. */
  mediaReferencesByFilename?: Map<
    string,
    {
      fileId: string;
      sessionId?: string;
      provider?: string;
      modelId?: string;
      updatedAt: number;
    }
  >;
  /** Filename->hash map for in-flight persistence reconciliation. */
  pendingPersistHashesByFilename?: Map<string, string>;
  /** Hash->last persistence failure metadata and retry backoff. */
  mediaPersistenceFailuresByHash?: Map<
    string,
    {
      filename: string;
      reason: string;
      failureCount: number;
      lastFailureAt: number;
      retryAfter: number;
    }
  >;
  /** Last auth status payload from SDK auth_status events. */
  lastAuthStatus?: {
    isAuthenticating: boolean;
    error?: string;
    output?: string[];
  };
  /** Last observed hook event emitted by the SDK. */
  lastHookEvent?: {
    subtype: "hook_started" | "hook_progress" | "hook_response";
    hookId?: string;
    hookName?: string;
    hookEvent?: string;
    outcome?: string;
  };
  /** Last observed task event emitted by the SDK. */
  lastTaskEvent?: {
    subtype: "task_started" | "task_progress" | "task_notification";
    taskId?: string;
    status?: string;
    description?: string;
  };
  /** Last rate-limit event payload emitted by the SDK. */
  lastRateLimitInfo?: unknown;
  /** Last prompt suggestion emitted by the SDK. */
  lastPromptSuggestion?: string;
};

// ---------------------------------------------------------------------------
// MCP tool server params
// ---------------------------------------------------------------------------

export type ClaudeSdkMcpToolServerParams = {
  tools: ClaudeSdkCompatibleTool[];
  emitEvent: (evt: EmbeddedPiSubscribeEvent) => void;
  getAbortSignal: () => AbortSignal | undefined;
  consumePendingToolUse: () => { id: string; name: string; input: unknown } | undefined;
  appendRuntimeMessage?: (message: AgentMessage) => void;
  sessionManager?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appendMessage?: (message: any) => string;
  };
};
