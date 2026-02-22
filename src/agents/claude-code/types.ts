/**
 * Configuration and result types for Claude Code spawn mode.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ClaudeCodePermissionMode =
  | "acceptEdits"
  | "bypassPermissions"
  | "default"
  | "delegate"
  | "dontAsk"
  | "plan";

export type ClaudeCodeSubagentConfig = {
  /** Enable Claude Code spawn mode (default: false). */
  enabled?: boolean;
  /** Absolute path to the `claude` binary (null = resolve from PATH). */
  binaryPath?: string | null;
  /** Default repo for spawns when none specified. */
  defaultRepo?: string | null;
  /** Repo alias → absolute path mapping. */
  repos?: Record<string, string>;
  /** USD cap per spawn (--max-budget-usd). */
  maxBudgetUsd?: number;
  /** Timeout per spawn in seconds. */
  timeoutSeconds?: number;
  /** Permission mode for the spawned CLI. */
  permissionMode?: ClaudeCodePermissionMode;
  /** Convenience alias: when true, overrides permissionMode to "bypassPermissions". */
  dangerouslySkipPermissions?: boolean;
  /** Model override (null = use claude's own resolution). */
  model?: string | null;
  /** MCP bridge server settings. */
  mcpBridge?: {
    /** Enable the MCP bridge (default: true). */
    enabled?: boolean;
  };
  /** Progress relay settings. */
  progressRelay?: {
    /** Enable progress relay to chat (default: true). */
    enabled?: boolean;
    /** How often to send progress to chat (seconds). */
    intervalSeconds?: number;
    /** Show which tools are being called. */
    includeToolUse?: boolean;
  };
  /** Session selection settings for intelligent resume vs fresh decisions. */
  sessionSelection?: Partial<SessionSelectionConfig>;
};

// ---------------------------------------------------------------------------
// Session selection config
// ---------------------------------------------------------------------------

export type SessionSelectionConfig = {
  /** Model for task relevance scoring. Default: "claude-haiku". */
  relevanceModel: string;
  /** Max response tokens for relevance call. Default: 500. */
  relevanceMaxTokens: number;
  /** Timeout for relevance call in ms. Default: 3000. */
  relevanceTimeoutMs: number;
  /** Score threshold for resume vs fresh. Default: 0.6. */
  resumeThreshold: number;
  /** Enable LLM-based relevance. False = keyword fallback only. Default: true. */
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

export type ClaudeCodeSpawnOptions = {
  task: string;
  /** Absolute path to repo root. */
  repo: string;
  model?: string;
  timeoutSeconds?: number;
  maxBudgetUsd?: number;
  permissionMode?: ClaudeCodePermissionMode;
  /** Session ID to resume. */
  resume?: string;
  /** Use --continue to resume the most recent session for this project. */
  continueSession?: boolean;
  /** Explicit session ID (UUID). */
  sessionId?: string;
  /** MCP bridge configuration. */
  mcpBridge?: ClaudeCodeSubagentConfig["mcpBridge"];
  /** Progress relay configuration. */
  progressRelay?: ClaudeCodeSubagentConfig["progressRelay"];
  /** Progress callback invoked during the run. */
  onProgress?: (event: ClaudeCodeProgressEvent) => void;
  /** Permission response callback — called when CC requests permission and we need user input. */
  onPermissionRequest?: (request: {
    toolName: string;
    description: string;
    requestId: string;
  }) => void;
  /** Agent ID (for session registry). */
  agentId?: string;
  /** Named session label — allows parallel sessions on the same repo. */
  label?: string;
  /** Binary path override. */
  binaryPath?: string;
  /** Keep the CC CLI process alive after the first result for follow-up messages. */
  persistent?: boolean;
};

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

export type ClaudeCodeProgressEvent =
  | { kind: "status"; permissionMode?: string; sessionId?: string }
  | { kind: "tool_use"; toolName: string; input?: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "hook_failed"; hookName: string; exitCode: number; output: string }
  | { kind: "task_notification"; taskId: string; status: string; summary?: string }
  | { kind: "auth_error"; error: string }
  | { kind: "progress_summary"; summary: string }
  | { kind: "permission_request"; toolName: string; description: string; requestId: string }
  | { kind: "result"; result: ClaudeCodeResult };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ClaudeCodeResult = {
  success: boolean;
  sessionId: string;
  /** Final assistant text. */
  result: string;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: { input_tokens: number; output_tokens: number };
  /** Actions the agent wanted but was denied. */
  permissionDenials: string[];
  errors: string[];
};

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

export type ClaudeCodeSessionEntry = {
  sessionId: string;
  createdAt: string;
  lastResumedAt: string;
  totalCostUsd: number;
  totalTurns: number;
  triggeredBy?: { userId?: string; channel?: string };
  taskHistory: ClaudeCodeTaskHistoryEntry[];
  /** Named session label (e.g. "dashboard-refactor"). Absent for the default session. */
  label?: string;
};

export type ClaudeCodeTaskHistoryEntry = {
  at: string;
  task: string;
  costUsd: number;
};

export type ClaudeCodeSessionRegistry = {
  sessions: Record<string, ClaudeCodeSessionEntry>;
};

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export type JsonlHeader = {
  gitBranch?: string;
  firstUserMessage?: string;
  slug?: string;
  version?: string;
  lineCount: number;
  originMarker?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  compactionCount: number;
};

export type DiscoveredSession = {
  sessionId: string;
  source: "openclaw" | "native-only";
  agentId?: string;
  repoPath: string;
  branch: string;
  /** First user message text (session "title"), max 200 chars. */
  firstMessage: string;
  lastModified: Date;
  messageCount: number;
  fileSizeBytes: number;
  totalCostUsd?: number;
  totalTurns?: number;
  lastTask?: string;
  label?: string;
  slug?: string;
  isRunning: boolean;
  originMarker?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  compactionCount: number;
  budgetUsedPct?: number;
};
