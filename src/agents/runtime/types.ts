/**
 * Agent Runtime Abstraction Layer — Core Types
 *
 * These interfaces decouple the rest of the OpenClaw codebase from any
 * specific agent runtime (pi-agent, Claude Agent SDK, etc.).
 *
 * Both the existing pi-agent runtime and the new Claude Agent SDK runtime
 * implement these interfaces so the migration can happen incrementally.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Content block within a message. */
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: MessageContent[]; isError?: boolean }
  | { type: "thinking"; thinking: string };

/** A message in the agent conversation. */
export interface RuntimeMessage {
  role: "user" | "assistant" | "system";
  content: string | MessageContent[];
  /** Provider-specific raw message. Preserved for session persistence. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A tool definition in the abstract format. */
export interface RuntimeToolDefinition {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the tool parameters. */
  parameterSchema: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: RuntimeToolResult) => void,
  ) => Promise<RuntimeToolResult>;
}

/** Result returned by a tool execution. */
export interface RuntimeToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; mediaType: string; data: string }
  >;
  details?: unknown;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Streaming Events
// ---------------------------------------------------------------------------

/** Normalized streaming events emitted by any runtime. */
export type RuntimeEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: RuntimeMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage }
  | { type: "message_start"; message: RuntimeMessage }
  | { type: "message_delta"; text: string }
  | { type: "message_end"; message: RuntimeMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partial: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; aborted: boolean }
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    }
  | { type: "error"; error: string; isRetryable: boolean };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Options for creating a session through the runtime. */
export interface CreateSessionOptions {
  /** Working directory for the agent. */
  cwd: string;
  /** Directory for agent-specific storage. */
  agentDir: string;
  /** Model identifier (e.g. "claude-opus-4-6"). */
  model: string;
  /** Thinking/reasoning level. */
  thinkLevel?: ThinkLevel;
  /** System prompt text. */
  systemPrompt: string;
  /** Tools available to the agent. */
  tools: RuntimeToolDefinition[];
  /** Existing session file path for resume. */
  sessionFile?: string;
  /** API key for the model provider. */
  apiKey?: string;
  /** Maximum context window tokens. */
  contextTokens?: number;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** An active agent session. */
export interface RuntimeSession {
  /** Unique session identifier. */
  readonly sessionId: string;

  /** Current conversation messages. */
  readonly messages: RuntimeMessage[];

  /** Whether the session is currently streaming a response. */
  readonly isStreaming: boolean;

  /** Send a prompt to the agent. Returns when the agent finishes responding. */
  prompt(text: string, images?: Array<{ mediaType: string; data: string }>): Promise<void>;

  /** Interrupt the agent mid-run with a steering message. */
  steer(text: string): void;

  /** Abort the current run. */
  abort(): void;

  /** Wait until the agent is idle (no active prompt). */
  waitForIdle(): Promise<void>;

  /** Subscribe to streaming events. Returns unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;

  /** Replace the system prompt. */
  setSystemPrompt(prompt: string): void;

  /** Replace the model. */
  setModel(model: string): void;

  /** Replace the thinking level. */
  setThinkLevel(level: ThinkLevel): void;

  /** Get the underlying provider-specific session for escape-hatch access. */
  getRawSession(): unknown;

  /** Clean up resources. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Session Persistence
// ---------------------------------------------------------------------------

/** Abstraction over session transcript persistence (JSONL files). */
export interface SessionStore {
  /** Load messages from the session file. */
  load(): Promise<RuntimeMessage[]>;

  /** Save all messages to the session file. */
  save(messages: RuntimeMessage[]): Promise<void>;

  /** Append a single message/entry to the session file. */
  append(entry: unknown): Promise<void>;

  /** Compact the session (summarize and reduce context). */
  compact(summary: string): Promise<void>;

  /** Branch the session into a new file. */
  branch(newSessionFile: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Which runtime implementation to use. */
export type RuntimeType = "pi-agent" | "claude-sdk";

/** The top-level runtime that creates sessions. */
export interface AgentRuntime {
  readonly type: RuntimeType;

  /** Create a new agent session. */
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;

  /** Clean up runtime resources. */
  dispose(): void;
}
