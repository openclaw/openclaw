import type { AgentMessage, AgentToolResult } from "./agent-core-contract.js";
import type { Api, Model } from "./pi-ai-contract.js";

export type AgentSessionEventListener<TEvent = unknown> = {
  bivarianceHack(event: TEvent): void;
}["bivarianceHack"];

export type AgentSession = {
  agent: {
    state: {
      systemPrompt: string;
    };
  };
  messages: AgentMessage[];
  sessionFile?: string;
  isCompacting: boolean;
  subscribe(listener: AgentSessionEventListener): () => void;
  abortCompaction(): void;
  setActiveToolsByName(toolNames: string[]): void;
};

export type FileOperations = {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
};

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type CompactOptions = {
  customInstructions?: string;
  onComplete?: (result: { summary: string }) => void;
  onError?: (error: Error) => void;
};

export type ExtensionContext = {
  cwd: string;
  sessionManager: object;
  modelRegistry: unknown;
  model: Model<Api> | undefined;
  isIdle(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
};

export type ContextEvent = {
  type: "context";
  messages: AgentMessage[];
};

export type ContextEventResult = {
  messages?: AgentMessage[];
};

export type CompactionPreparation = {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages?: AgentMessage[];
  previousSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps: FileOperations;
  isSplitTurn?: boolean;
  settings: {
    reserveTokens: number;
  };
};

export type SessionBeforeCompactEvent = {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  customInstructions?: string;
  signal: AbortSignal;
};

export type SessionBeforeCompactResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

export type ToolResultEvent = {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: AgentToolResult["content"];
  details?: unknown;
  isError: boolean;
};

export type ToolResultEventResult = {
  content?: AgentToolResult["content"];
  details?: unknown;
  isError?: boolean;
};

export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

export type ExtensionAPI = {
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(
    event: "session_before_compact",
    handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
  ): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
};
