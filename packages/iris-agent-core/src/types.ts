/**
 * Type definitions — mirrors @mariozechner/pi-agent-core types exactly.
 * Runtime: empty (TypeScript only).
 */
import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  streamSimple,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ToolResultCompressionOptions } from "./context-compressor.js";

export type StreamFn = (
  ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

export interface AgentLoopConfig extends SimpleStreamOptions {
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
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentMessage = Message;

export interface AgentState {
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

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<
  TParameters extends Tool["parameters"] = Tool["parameters"],
  TDetails = unknown,
> extends Tool<TParameters> {
  label: string;
  /**
   * When true, results are memoized by (name, args) for the duration of
   * the agent run (subject to toolCacheMs in AgentLoopConfig).
   * Set only for pure/idempotent tools (read, grep, find, ls, web_fetch…).
   * Never set for tools with side effects (exec, write, edit…).
   */
  cacheable?: boolean;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
