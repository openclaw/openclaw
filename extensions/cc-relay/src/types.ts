/**
 * A dispatched task that is pending or running in the background.
 */
export interface CcRelayJob {
  /** Unique job identifier. */
  id: string;
  /** Short human-readable label for the task. */
  taskName: string;
  /** The prompt forwarded verbatim from the user. */
  prompt: string;
  /** Channel that originated the request (e.g. "feishu", "discord"). */
  channel: string;
  /** Target group/chat/thread to send results to. */
  target: string;
  /** Working directory for Claude Code. */
  workdir: string;
  /** Claude Code permission mode. */
  permissionMode: string;
  /** Anthropic model identifier. */
  model: string;
  /** Whether to start a fresh session (true) or continue the latest (false). */
  fresh: boolean;
  /** Maximum execution time in seconds. */
  timeoutSeconds: number;
  /** ISO timestamp when the job was created. */
  createdAt: string;
  /** Current status. */
  status: "queued" | "running" | "completed" | "failed" | "timeout";
  /** Exit code from Claude Code CLI, if finished. */
  exitCode?: number;
  /** ISO timestamp when the job completed. */
  completedAt?: string;
  /** Paths of files created or modified during execution. */
  newFiles?: string[];
}

/**
 * An entry parsed from a Claude Code JSONL session file.
 */
export interface SessionEntry {
  type: "user" | "assistant" | "last-prompt" | string;
  message?: {
    content?: SessionContentBlock[];
  };
}

export type SessionContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | Record<string, unknown>;

/**
 * Progress entry extracted from the JSONL stream.
 */
export interface ProgressEntry {
  kind: "text" | "tool";
  content: string;
}
