import { AssistantMessage, AssistantMessageEvent, Context, EventStream, ImageContent, Message, Model, SimpleStreamOptions, StopReason, TextContent, Tool, ToolResultMessage, streamSimple } from "@mariozechner/pi-ai";

//#region src/context-compressor.d.ts
interface ToolResultCompressionOptions {
  /** How many user-turns from the end to keep uncompressed. Default: 2 */
  ageTurns?: number;
  /** Max characters per tool result before truncation. Default: 100 */
  maxChars?: number;
  /**
   * Max characters per assistant text block before truncation. Default: 300.
   * Set to 0 to skip assistant message compression.
   */
  maxAssistantChars?: number;
}
/**
 * Rough character count across all message content blocks.
 * Used to measure compression savings (not an exact tokenizer).
 */
declare function estimateMessageChars(messages: AgentMessage[]): number;
/** Convert a char estimate to approximate tokens. */
declare function charsToTokens(chars: number): number;
/**
 * Compresses messages older than `ageTurns` user-turns.
 *
 * - ToolResultMessages: text truncated to maxChars (Stage 1).
 * - AssistantMessages:  text truncated to maxAssistantChars; thinking dropped (Stage 2).
 * - UserMessages: unchanged.
 *
 * Returns a new array; never mutates the originals.
 */
declare function compressAgedToolResults(messages: AgentMessage[], opts?: ToolResultCompressionOptions): AgentMessage[];
//#endregion
//#region src/types.d.ts
type StreamFn = (...args: Parameters<typeof streamSimple>) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<string>;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /**
   * Per-tool execution timeout in milliseconds.
   * When a tool exceeds this limit its AbortSignal is triggered and the tool
   * receives an error result. Other tools in the same parallel batch continue.
   * 0 or undefined = no timeout.
   */
  toolTimeoutMs?: number;
  /**
   * Tool result cache TTL in milliseconds.
   * Only tools with `cacheable: true` are cached.
   * -1 = session-scoped (cache lives for the entire agent run).
   *  0 or undefined = caching disabled.
   */
  toolCacheMs?: number;
  /**
   * Age-based tool result compression.
   * Truncates text content of ToolResultMessages in old turns to reduce
   * context bloat. Runs before every LLM call, before transformContext.
   * undefined  = use defaults (ageTurns: 2, maxChars: 100, maxAssistantChars: 300) — on by default.
   * false      = disabled.
   * object     = custom options.
   */
  toolResultCompression?: ToolResultCompressionOptions | false;
  /**
   * Max tools executed simultaneously in one parallel batch.
   * Default: 5. 0 or undefined = 5.
   * Set to a large number (e.g. 100) to effectively disable the limit.
   */
  maxParallelTools?: number;
}
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type AgentMessage = Message;
interface AgentState {
  systemPrompt: string;
  model: Model<string>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;
  pendingToolCalls: Set<string>;
  error?: string;
}
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}
type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;
interface AgentTool<TParameters extends Tool["parameters"] = Tool["parameters"], TDetails = unknown> extends Tool<TParameters> {
  label: string;
  /**
   * When true, results are memoized by (name, args) for the duration of
   * the agent run (subject to toolCacheMs in AgentLoopConfig).
   * Set only for pure/idempotent tools (read, grep, find, ls, web_fetch…).
   * Never set for tools with side effects (exec, write, edit…).
   */
  cacheable?: boolean;
  execute: (toolCallId: string, params: TParameters, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
}
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}
type AgentEvent = {
  type: "agent_start";
} | {
  type: "agent_end";
  messages: AgentMessage[];
} | {
  type: "turn_start";
} | {
  type: "turn_end";
  message: AgentMessage;
  toolResults: ToolResultMessage[];
} | {
  type: "message_start";
  message: AgentMessage;
} | {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
} | {
  type: "message_end";
  message: AgentMessage;
} | {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} | {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
} | {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};
//#endregion
//#region src/agent-loop.d.ts
/**
 * Start an agent loop with a new prompt message.
 * Identical signature to pi-agent-core's agentLoop — drop-in replacement.
 */
declare function agentLoop(prompts: AgentMessage[], context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal, streamFn?: StreamFn): EventStream<AgentEvent, AgentMessage[]>;
/**
 * Continue an agent loop from the current context without adding a new message.
 * Identical signature to pi-agent-core's agentLoopContinue.
 */
declare function agentLoopContinue(context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal, streamFn?: StreamFn): EventStream<AgentEvent, AgentMessage[]>;
//#endregion
//#region src/agent.d.ts
interface IrisAgentOptions {
  initialState?: Partial<AgentState>;
  convertToLlm?: AgentLoopConfig["convertToLlm"];
  transformContext?: AgentLoopConfig["transformContext"];
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  streamFn?: StreamFn;
  sessionId?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  thinkingBudgets?: Record<string, number>;
  transport?: "sse" | "stream";
  maxRetryDelayMs?: number;
}
declare class IrisAgent {
  private _state;
  private listeners;
  private abortController?;
  private convertToLlm;
  private transformContext?;
  private steeringQueue;
  private followUpQueue;
  private steeringMode;
  private followUpMode;
  streamFn: StreamFn;
  private _sessionId?;
  private getApiKey?;
  private _thinkingBudgets?;
  private _transport;
  private _maxRetryDelayMs?;
  private runningPrompt?;
  private resolveRunningPrompt?;
  constructor(opts?: IrisAgentOptions);
  get state(): AgentState;
  get sessionId(): string | undefined;
  set sessionId(value: string | undefined);
  get thinkingBudgets(): Record<string, number> | undefined;
  set thinkingBudgets(value: Record<string, number> | undefined);
  get transport(): "sse" | "stream";
  setTransport(value: "sse" | "stream"): void;
  get maxRetryDelayMs(): number | undefined;
  set maxRetryDelayMs(value: number | undefined);
  setSystemPrompt(v: string): void;
  setModel(m: AgentState["model"]): void;
  setThinkingLevel(l: ThinkingLevel): void;
  setSteeringMode(mode: "one-at-a-time" | "all"): void;
  getSteeringMode(): "one-at-a-time" | "all";
  setFollowUpMode(mode: "one-at-a-time" | "all"): void;
  getFollowUpMode(): "one-at-a-time" | "all";
  setTools(t: AgentTool[]): void;
  replaceMessages(ms: AgentMessage[]): void;
  appendMessage(m: AgentMessage): void;
  /** Queue a steering message to interrupt the agent mid-run. */
  steer(m: AgentMessage): void;
  /** Queue a follow-up message to process after the agent finishes. */
  followUp(m: AgentMessage): void;
  clearSteeringQueue(): void;
  clearFollowUpQueue(): void;
  clearAllQueues(): void;
  hasQueuedMessages(): boolean;
  clearMessages(): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;
  subscribe(fn: (event: AgentEvent) => void): () => void;
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void>;
  continue(): Promise<void>;
  private _runLoop;
  private _dequeueSteeringMessages;
  private _dequeueFollowUpMessages;
  private _emit;
}
//#endregion
//#region src/proxy.d.ts
type ProxyAssistantMessageEvent = {
  type: "start";
} | {
  type: "text_start";
  contentIndex: number;
} | {
  type: "text_delta";
  contentIndex: number;
  delta: string;
} | {
  type: "text_end";
  contentIndex: number;
  contentSignature?: string;
} | {
  type: "thinking_start";
  contentIndex: number;
} | {
  type: "thinking_delta";
  contentIndex: number;
  delta: string;
} | {
  type: "thinking_end";
  contentIndex: number;
  contentSignature?: string;
} | {
  type: "toolcall_start";
  contentIndex: number;
  id: string;
  toolName: string;
} | {
  type: "toolcall_delta";
  contentIndex: number;
  delta: string;
} | {
  type: "toolcall_end";
  contentIndex: number;
} | {
  type: "done";
  reason: Extract<StopReason, "stop" | "length" | "toolUse">;
  usage: AssistantMessage["usage"];
} | {
  type: "error";
  reason: Extract<StopReason, "aborted" | "error">;
  errorMessage?: string;
  usage: AssistantMessage["usage"];
};
interface ProxyStreamOptions extends SimpleStreamOptions {
  authToken: string;
  proxyUrl: string;
}
declare function streamProxy(model: Model<string>, context: Context, options: ProxyStreamOptions): EventStream<AssistantMessageEvent, AssistantMessage>;
//#endregion
export { IrisAgent as Agent, IrisAgent, AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentState, AgentTool, AgentToolResult, AgentToolUpdateCallback, IrisAgentOptions, ProxyAssistantMessageEvent, ProxyStreamOptions, StreamFn, ThinkingLevel, ToolResultCompressionOptions, agentLoop, agentLoopContinue, charsToTokens, compressAgedToolResults, estimateMessageChars, streamProxy };