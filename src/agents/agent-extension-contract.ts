import type { Static, TSchema } from "typebox";
import type {
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "./agent-core-contract.js";
import type {
  Api,
  ImageContent,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
  TextContent,
} from "./pi-ai-contract.js";
import type { CompactionEntry, SessionEntry } from "./transcript/session-transcript-contract.js";

export type ToolExecutionMode = "sequential" | "parallel";

export type AgentSessionEventListener<TEvent = unknown> = {
  bivarianceHack(event: TEvent): void;
}["bivarianceHack"];

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export type SourceInfo = {
  path: string;
  source: string;
  scope: SourceScope;
  origin: SourceOrigin;
  baseDir?: string;
};

export type Skill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
};

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

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
> = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: unknown,
  ): Promise<AgentToolResult<TDetails>>;
};

export type ProviderConfig = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (model: Model<Api>, context: unknown, options?: SimpleStreamOptions) => unknown;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
  }>;
  oauth?: {
    name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  };
};

export type CustomMessage<T = unknown> = {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
};

export type SessionCompactEvent = {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
};

export type SessionBeforeTreeEvent = {
  type: "session_before_tree";
  preparation: {
    targetId: string;
    oldLeafId: string | null;
    commonAncestorId: string | null;
    entriesToSummarize: SessionEntry[];
    userWantsSummary: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  };
  signal: AbortSignal;
};
