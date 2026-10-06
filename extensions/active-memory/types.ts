import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionTranscriptTargetParams } from "openclaw/plugin-sdk/session-transcript-runtime";

export const DEFAULT_TIMEOUT_MS = 15_000;
// CLI-runtime recalls dispatch through a fresh CLI process (spawn + MCP
// handshake + tool roundtrips); measured runs take 14-20s, so the plain
// default budget would time out most of them. Explicit timeoutMs config
// always wins over this default.
export const DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS = 45_000;
export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAX_SUMMARY_CHARS = 220;
export const DEFAULT_RECENT_USER_TURNS = 2;
export const DEFAULT_RECENT_ASSISTANT_TURNS = 1;
export const DEFAULT_RECENT_USER_CHARS = 220;
export const DEFAULT_RECENT_ASSISTANT_CHARS = 180;
export const DEFAULT_CACHE_TTL_MS = 15_000;
export const DEFAULT_MAX_CACHE_ENTRIES = 1000;
export const CACHE_SWEEP_INTERVAL_MS = 1000;
export const DEFAULT_MIN_TIMEOUT_MS = 250;
export const DEFAULT_SETUP_GRACE_TIMEOUT_MS = 0;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_SETUP_GRACE_TIMEOUT_MS = 30_000;
export const DEFAULT_QUERY_MODE = "recent" as const;
export const DEFAULT_ACTIVE_MEMORY_MODE = "escalate" as const;
export const DEFAULT_TRANSCRIPT_DIR = "active-memory";
export const ACTIVE_MEMORY_RECALL_LANE = "active-memory";
export const ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS = [0, 50, 250] as const;
export const DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS = 3;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
export const DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW = ["memory_search", "memory_get"] as const;
export const LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW = ["memory_recall"] as const;
export const MAX_ACTIVE_MEMORY_TOOLS_ALLOW = 32;
export const STRUCTURED_MEMORY_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "timeout",
  "timed_out",
  "denied",
  "cancelled",
  "canceled",
  "aborted",
  "killed",
  "invalid",
  "forbidden",
  "unavailable",
  "disabled",
  "blocked",
]);
export const STRUCTURED_MEMORY_EMPTY_STATUSES = new Set([
  "not_found",
  "empty",
  "no_results",
  "no_matches",
]);
export const ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW = new Set([
  "*",
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "heartbeat_respond",
  "heartbeat_response",
  "image",
  "image_generate",
  "message",
  "music_generate",
  "nodes",
  "pdf",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "tts",
  "progress_card",
  "video_generate",
  "web_fetch",
  "web_search",
  "write",
]);
export const DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS = 32_000;
export const DEFAULT_TRANSCRIPT_READ_MAX_LINES = 2_000;
export const DEFAULT_TRANSCRIPT_READ_MAX_BYTES = 50 * 1024 * 1024;
export const TIMEOUT_PARTIAL_DATA_GRACE_MS = 500;
export const HOOK_TIMEOUT_RECOVERY_GRACE_MS = TIMEOUT_PARTIAL_DATA_GRACE_MS + 1_000;
// Optional trigger lookup must give up strictly before the preflight
// watchdog fires, or the watchdog skips the whole invocation instead of
// letting model recall continue without trigger context.
export const TRIGGER_LOOKUP_SETTLE_RESERVE_MS = 50;
export const MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS = 480;
export const TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS = 25;

export const NO_RECALL_VALUES = new Set([
  "",
  "none",
  "no_reply",
  "no reply",
  "nothing useful",
  "no relevant memory",
  "no relevant memories",
  "timeout",
  "timed out",
  "request timed out",
  "llm request timed out",
  "the llm request timed out",
  "[]",
  "{}",
  "null",
  "n/a",
]);

export const TIMEOUT_BOILERPLATE_PATTERNS = [
  /^(?:error:\s*)?(?:the\s+)?(?:llm|model|request|operation|agent)\s+(?:request\s+)?timed out\b/i,
  /^(?:error:\s*)?active-memory timeout after \d+ms\b/i,
];

export const RECALLED_CONTEXT_LINE_PATTERNS = [
  /^🧩\s*active memory:/i,
  /^🔎\s*active memory debug:/i,
  /^🧠\s*memory search:/i,
  /^memory search:/i,
  /^active memory debug:/i,
  /^active memory:/i,
];

export type ActiveRecallPluginConfig = Partial<
  Omit<ResolvedActiveRecallPluginConfig, "timeoutMsIsDefault">
> & {
  modelFallbackPolicy?: "default-remote" | "resolved-only";
};

export type ResolvedActiveRecallPluginConfig = {
  enabled: boolean;
  mode: ActiveMemoryMode;
  agents: string[];
  model?: string;
  modelFallback?: string;
  allowedChatTypes: ActiveMemoryChatType[];
  allowedChatIds: string[];
  deniedChatIds: string[];
  thinking: ActiveMemoryThinkingLevel;
  fastMode?: ActiveMemoryFastMode;
  promptStyle: ActiveMemoryPromptStyle;
  toolsAllow: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs: number;
  /** True when timeoutMs is the built-in default rather than operator config. */
  timeoutMsIsDefault: boolean;
  setupGraceTimeoutMs: number;
  queryMode: "message" | "recent" | "full";
  maxSummaryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  logging: boolean;
  cacheTtlMs: number;
  circuitBreakerMaxTimeouts: number;
  circuitBreakerCooldownMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
};

export type ActiveRecallRecentTurn = {
  role: "user" | "assistant";
  text: string;
};

export type ActiveMemorySearchDebug = {
  backend?: string;
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
  searchMs?: number;
  hits?: number;
  warning?: string;
  action?: string;
  error?: string;
};

export type ActiveRecallResult = {
  elapsedMs: number;
  searchDebug?: ActiveMemorySearchDebug;
} & (
  | {
      status: "empty" | "failed" | "no_relevant_memory" | "timeout" | "unavailable";
      summary: string | null;
    }
  | {
      status: "timeout_partial";
      summary: string;
    }
  | {
      status: "ok";
      rawReply: string;
      summary: string;
    }
);

export type ActiveMemoryPartialTimeoutData = Partial<RecallSubagentResult> & {
  cleanupFailed?: boolean;
};

export type ActiveMemoryPartialTimeoutError = Error & {
  activeMemoryPartialData?: ActiveMemoryPartialTimeoutData;
};

export type TranscriptReadLimits = {
  maxChars?: number;
  maxLines?: number;
  maxBytes?: number;
};

export type ActiveMemoryTranscriptSource = SessionTranscriptTargetParams;

export type RecallSubagentResult = {
  rawReply: string;
  resultStatus?: "failed" | "unavailable";
  transcriptPath?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult?: boolean;
  hasUnavailableMemorySearchResult?: boolean;
};

export type TerminalMemorySearchResult = {
  status: "unavailable";
  hasUsableMemoryResult: boolean;
  searchDebug?: ActiveMemorySearchDebug;
};

export type TerminalMemorySearchWatch = {
  promise: Promise<TerminalMemorySearchResult>;
  stop: () => void;
};

export type CachedActiveRecallResult = {
  expiresAt: number;
  result: ActiveRecallResult;
};

export type ActiveMemoryChatType = "direct" | "group" | "channel" | "explicit";
export type ActiveMemoryMode = "escalate" | "always" | "off";

export type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: true;
  updatedAt: number;
};
export type ActiveMemoryThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";
export type ActiveMemoryFastMode = boolean | "auto";
export type ConversationRecallContext = NonNullable<
  OpenClawPluginToolContext["conversationRecall"]
>;
export type ActiveMemoryPromptStyle =
  | "balanced"
  | "strict"
  | "contextual"
  | "recall-heavy"
  | "precision-heavy"
  | "preference-only";

export const ACTIVE_MEMORY_STATUS_PREFIX = "🧩 Active Memory:";
export const ACTIVE_MEMORY_DEBUG_PREFIX = "🔎 Active Memory Debug:";
export const ACTIVE_MEMORY_PLUGIN_TAG = "active_memory_plugin";
export const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
export const ACTIVE_MEMORY_OPEN_TAG = `<${ACTIVE_MEMORY_PLUGIN_TAG}>`;
export const ACTIVE_MEMORY_CLOSE_TAG = `</${ACTIVE_MEMORY_PLUGIN_TAG}>`;
export const MAX_LOG_VALUE_CHARS = 300;
export type CircuitBreakerEntry = {
  consecutiveTimeouts: number;
  lastTimeoutAt: number;
};
