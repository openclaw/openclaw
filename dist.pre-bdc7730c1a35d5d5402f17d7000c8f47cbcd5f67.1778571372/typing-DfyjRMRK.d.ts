//#region src/auto-reply/reply/response-prefix-template.d.ts
/**
 * Template interpolation for response prefix.
 *
 * Supports variables like `{model}`, `{provider}`, `{thinkingLevel}`, etc.
 * Variables are case-insensitive and unresolved ones remain as literal text.
 */
type ResponsePrefixContext = {
  /** Short model name (e.g., "gpt-5.4", "claude-opus-4-6") */model?: string; /** Full model ID including provider (e.g., "openai/gpt-5.5") */
  modelFull?: string; /** Provider name (e.g., "openai-codex", "anthropic") */
  provider?: string; /** Current thinking level (e.g., "high", "low", "off") */
  thinkingLevel?: string; /** Agent identity name */
  identityName?: string;
};
//#endregion
//#region src/channels/typing.d.ts
type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void; /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
};
type CreateTypingCallbacksParams = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number; /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number; /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;
};
declare function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks;
//#endregion
export { ResponsePrefixContext as i, TypingCallbacks as n, createTypingCallbacks as r, CreateTypingCallbacksParams as t };