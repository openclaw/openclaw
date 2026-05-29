import { n as DiagnosticErrorInfo, t as AssistantMessageDiagnostic } from "./diagnostics-Drvc4fHy.mjs";
import { TSchema } from "typebox";

//#region packages/llm-core/src/types.d.ts
type KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex";
type Api = KnownApi | (string & {});
type KnownImagesApi = "openrouter-images";
type ImagesApi = KnownImagesApi | (string & {});
type Provider = string;
type KnownImagesProvider = "openrouter";
type ImagesProvider = string;
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelThinkingLevel = "off" | ThinkingLevel;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
/** Token budgets for each thinking level (token-based providers only) */
interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  max?: number;
}
type CacheRetention = "none" | "short" | "long";
type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
type MaybePromise<T> = T | Promise<T>;
interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}
interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  /**
   * Preferred transport for providers that support multiple transports.
   * Providers that do not support this option ignore it.
   */
  transport?: Transport;
  /**
   * Prompt cache retention preference. Providers map this to their supported values.
   * Default: "short".
   */
  cacheRetention?: CacheRetention;
  /**
   * Optional session identifier for providers that support session-based caching.
   * Providers can use this to enable prompt caching, request routing, or other
   * session-aware features. Ignored by providers that don't support it.
   */
  sessionId?: string;
  /**
   * Optional provider prompt-cache affinity key, distinct from transcript/session identity.
   * Providers that do not support separate cache affinity ignore it.
   */
  promptCacheKey?: string;
  /**
   * Optional callback for inspecting or replacing provider payloads before sending.
   * Return undefined to keep the payload unchanged.
   */
  onPayload?: (payload: unknown, model: Model) => MaybePromise<unknown>;
  /**
   * Optional callback invoked after an HTTP response is received and before
   * its body stream is consumed.
   */
  onResponse?: (response: ProviderResponse, model: Model) => void | Promise<void>;
  /**
   * Optional custom HTTP headers to include in API requests.
   * Merged with provider defaults; can override default headers.
   * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
   */
  headers?: Record<string, string>;
  /**
   * HTTP request timeout in milliseconds for providers/SDKs that support it.
   * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
   */
  timeoutMs?: number;
  /**
   * Maximum retry attempts for providers/SDKs that support client-side retries.
   * For example, OpenAI and Anthropic SDK clients default to 2.
   */
  maxRetries?: number;
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
   * If the server's requested delay exceeds this value, the request fails immediately
   * with an error containing the requested delay, allowing higher-level retry logic
   * to handle it with user visibility.
   * Default: 60000 (60 seconds). Set to 0 to disable the cap.
   */
  maxRetryDelayMs?: number;
  /**
   * Optional metadata to include in API requests.
   * Providers extract the fields they understand and ignore the rest.
   * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
   */
  metadata?: Record<string, unknown>;
}
type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
interface ImagesOptions {
  signal?: AbortSignal;
  apiKey?: string;
  /**
   * Optional callback for inspecting or replacing provider payloads before sending.
   * Return undefined to keep the payload unchanged.
   */
  onPayload?: (payload: unknown, model: ImagesModel) => MaybePromise<unknown>;
  /**
   * Optional callback invoked after an HTTP response is received.
   */
  onResponse?: (response: ProviderResponse, model: ImagesModel) => void | Promise<void>;
  /**
   * Optional custom HTTP headers to include in API requests.
   * Merged with provider defaults; can override default headers.
   */
  headers?: Record<string, string>;
  /**
   * HTTP request timeout in milliseconds for providers/SDKs that support it.
   */
  timeoutMs?: number;
  /**
   * Maximum retry attempts for providers/SDKs that support client-side retries.
   */
  maxRetries?: number;
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
   * If the server's requested delay exceeds this value, the request fails immediately
   * with an error containing the requested delay, allowing higher-level retry logic
   * to handle it with user visibility.
   * Default: 60000 (60 seconds). Set to 0 to disable the cap.
   */
  maxRetryDelayMs?: number;
  /**
   * Optional metadata to include in API requests.
   * Providers extract the fields they understand and ignore the rest.
   */
  metadata?: Record<string, unknown>;
}
type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;
interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  /** Custom token budgets for thinking levels (token-based providers only) */
  thinkingBudgets?: ThinkingBudgets;
}
type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStreamContract;
type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (model: ImagesModel<TApi>, context: ImagesContext, options?: TOptions) => Promise<AssistantImages>;
interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** When true, the thinking content was redacted by safety filters. The opaque
   *  encrypted payload is stored in `thinkingSignature` so it can be passed back
   *  to the API for multi-turn continuity. */
  redacted?: boolean;
}
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  executionMode?: "sequential" | "parallel";
}
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}
interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
type Message = UserMessage | AssistantMessage | ToolResultMessage;
type ImagesInputContent = TextContent | ImageContent;
type ImagesOutputContent = TextContent | ImageContent;
interface ImagesContext {
  input: ImagesInputContent[];
}
type ImagesStopReason = "stop" | "error" | "aborted";
interface AssistantImages {
  api: ImagesApi;
  provider: ImagesProvider;
  model: string;
  output: ImagesOutputContent[];
  responseId?: string;
  usage?: Usage;
  stopReason: ImagesStopReason;
  errorMessage?: string;
  timestamp: number;
}
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
type AssistantMessageEvent = {
  type: "start";
  partial: AssistantMessage;
} | {
  type: "text_start";
  contentIndex: number;
  partial: AssistantMessage;
} | {
  type: "text_delta";
  contentIndex: number;
  delta: string;
  partial: AssistantMessage;
} | {
  type: "text_end";
  contentIndex: number;
  content: string;
  partial: AssistantMessage;
} | {
  type: "thinking_start";
  contentIndex: number;
  partial: AssistantMessage;
} | {
  type: "thinking_delta";
  contentIndex: number;
  delta: string;
  partial: AssistantMessage;
} | {
  type: "thinking_end";
  contentIndex: number;
  content: string;
  partial: AssistantMessage;
} | {
  type: "toolcall_start";
  contentIndex: number;
  partial: AssistantMessage;
} | {
  type: "toolcall_delta";
  contentIndex: number;
  delta: string;
  partial: AssistantMessage;
} | {
  type: "toolcall_end";
  contentIndex: number;
  toolCall: ToolCall;
  partial: AssistantMessage;
} | {
  type: "done";
  reason: Extract<StopReason, "stop" | "length" | "toolUse">;
  message: AssistantMessage;
} | {
  type: "error";
  reason: Extract<StopReason, "aborted" | "error">;
  error: AssistantMessage;
};
interface AssistantMessageEventStreamContract extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}
interface AssistantMessageEventStreamLike extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}
/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
interface OpenAICompletionsCompat {
  /** Whether the provider supports the `store` field. Default: auto-detected from URL. */
  supportsStore?: boolean;
  /** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
  supportsDeveloperRole?: boolean;
  /** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
  supportsReasoningEffort?: boolean;
  /** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
  supportsUsageInStreaming?: boolean;
  /** Which field to use for max tokens. Default: auto-detected from URL. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Whether tool results require the `name` field. Default: auto-detected from URL. */
  requiresToolResultName?: boolean;
  /** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
  requiresAssistantAfterToolResult?: boolean;
  /** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
  requiresThinkingAsText?: boolean;
  /** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort, "together" uses reasoning: { enabled } plus reasoning_effort when supported, "zai" uses top-level enable_thinking: boolean, "qwen" uses top-level enable_thinking: boolean, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
  /** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
  openRouterRouting?: OpenRouterRouting;
  /** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
  vercelGatewayRouting?: VercelGatewayRouting;
  /** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
  zaiToolStream?: boolean;
  /** Whether the provider supports the `strict` field in tool definitions. Default: true. */
  supportsStrictMode?: boolean;
  /** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user/assistant text content. */
  cacheControlFormat?: "anthropic";
  /** Whether to send known session-affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`) from `options.sessionId` when caching is enabled. Default: false. */
  sendSessionAffinityHeaders?: boolean;
  /** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
  supportsLongCacheRetention?: boolean;
}
/** Compatibility settings for OpenAI Responses APIs. */
interface OpenAIResponsesCompat {
  /** Whether to send the OpenAI `session_id` cache-affinity header from `options.sessionId` when caching is enabled. Default: true. */
  sendSessionIdHeader?: boolean;
  /** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
  supportsLongCacheRetention?: boolean;
}
/** Compatibility settings for Anthropic Messages-compatible APIs. */
interface AnthropicMessagesCompat {
  /**
   * Whether the provider accepts per-tool `eager_input_streaming`.
   * When false, the Anthropic provider omits `tools[].eager_input_streaming`
   * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
   * for tool-enabled requests.
   * Default: true.
   */
  supportsEagerToolInputStreaming?: boolean;
  /** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether to send the `x-session-affinity` header from `options.sessionId`
   * when caching is enabled. Required for providers like Fireworks that use
   * session affinity for prompt cache routing (requests to the same replica
   * maximize cache hits).
   * Default: false.
   */
  sendSessionAffinityHeaders?: boolean;
  /**
   * Whether the provider supports Anthropic-style `cache_control` markers on
   * tool definitions. When false, `cache_control` is omitted from tool params.
   * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
   * field on tools and may reject or ignore it.
   * Default: true.
   */
  supportsCacheControlOnTools?: boolean;
}
/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * Sent as the `provider` field in the OpenRouter API request body.
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
interface OpenRouterRouting {
  /** Whether to allow backup providers to serve requests. Default: true. */
  allow_fallbacks?: boolean;
  /** Whether to filter providers to only those that support all parameters in the request. Default: false. */
  require_parameters?: boolean;
  /** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
  data_collection?: "deny" | "allow";
  /** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
  zdr?: boolean;
  /** Whether to restrict routing to only models that allow text distillation. */
  enforce_distillable_text?: boolean;
  /** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
  order?: string[];
  /** List of provider names/slugs to exclusively allow for this request. */
  only?: string[];
  /** List of provider names/slugs to skip for this request. */
  ignore?: string[];
  /** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
  quantizations?: string[];
  /** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
  sort?: string | {
    /** The sorting metric: "price", "throughput", "latency". */by?: string; /** Partitioning strategy: "model" (default) or "none". */
    partition?: string | null;
  };
  /** Maximum price per million tokens (USD). */
  max_price?: {
    /** Price per million prompt tokens. */prompt?: number | string; /** Price per million completion tokens. */
    completion?: number | string; /** Price per image. */
    image?: number | string; /** Price per audio unit. */
    audio?: number | string; /** Price per request. */
    request?: number | string;
  };
  /** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
  preferred_min_throughput?: number | {
    /** Minimum tokens/second at the 50th percentile. */p50?: number; /** Minimum tokens/second at the 75th percentile. */
    p75?: number; /** Minimum tokens/second at the 90th percentile. */
    p90?: number; /** Minimum tokens/second at the 99th percentile. */
    p99?: number;
  };
  /** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
  preferred_max_latency?: number | {
    /** Maximum latency in seconds at the 50th percentile. */p50?: number; /** Maximum latency in seconds at the 75th percentile. */
    p75?: number; /** Maximum latency in seconds at the 90th percentile. */
    p90?: number; /** Maximum latency in seconds at the 99th percentile. */
    p99?: number;
  };
}
/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
interface VercelGatewayRouting {
  /** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
  only?: string[];
  /** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
  order?: string[];
}
interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  /**
   * Maps OpenClaw thinking levels to provider/model-specific values.
   * Missing keys use provider defaults. null marks a level as unsupported.
   */
  thinkingLevelMap?: ThinkingLevelMap;
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
  /** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat : TApi extends "openai-responses" ? OpenAIResponsesCompat : TApi extends "anthropic-messages" ? AnthropicMessagesCompat : never;
}
interface ImagesModel<TApi extends ImagesApi = ImagesApi> extends Omit<Model, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
  api: TApi;
  provider: ImagesProvider;
  output: ("text" | "image")[];
}
type StreamFn = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>;
type CompleteSimpleFn = (model: Model, context: Pick<Context, "systemPrompt" | "messages">, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
type ValidateToolArgumentsFn = (tool: Tool, toolCall: ToolCall) => unknown;
//#endregion
export { AnthropicMessagesCompat, Api, AssistantImages, AssistantMessage, type AssistantMessageDiagnostic, AssistantMessageEvent, AssistantMessageEventStreamContract, AssistantMessageEventStreamLike, CacheRetention, CompleteSimpleFn, Context, type DiagnosticErrorInfo, ImageContent, ImagesApi, ImagesContext, ImagesFunction, ImagesInputContent, ImagesModel, ImagesOptions, ImagesOutputContent, ImagesProvider, ImagesStopReason, KnownApi, KnownImagesApi, KnownImagesProvider, MaybePromise, Message, Model, ModelThinkingLevel, OpenAICompletionsCompat, OpenAIResponsesCompat, OpenRouterRouting, Provider, ProviderImagesOptions, ProviderResponse, ProviderStreamOptions, SimpleStreamOptions, StopReason, StreamFn, StreamFunction, StreamOptions, TextContent, TextSignatureV1, ThinkingBudgets, ThinkingContent, ThinkingLevel, ThinkingLevelMap, Tool, ToolCall, ToolResultMessage, Transport, Usage, UserMessage, ValidateToolArgumentsFn, VercelGatewayRouting };