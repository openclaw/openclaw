/**
 * Assistant stream message builders.
 *
 * Centralizes zero-cost usage records and assistant message construction for simple stream transports.
 */
import type { AssistantMessage, StopReason, Usage } from "../llm/types.js";

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

export function buildZeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: params.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function buildAssistantMessageWithZeroUsage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  timestamp?: number;
}): AssistantMessage {
  return buildAssistantMessage({
    model: params.model,
    content: params.content,
    stopReason: params.stopReason,
    usage: buildZeroUsage(),
    timestamp: params.timestamp,
  });
}

// Single canonical sentinel placed in the `content` array of any assistant turn
// that failed before the model produced its own content. AWS Bedrock Converse
// rejects assistant messages with `content: []` during replay ("The content
// field in the Message object at messages.N is empty."), which can persist into
// the session file and trap subsequent turns in a validation-failure loop. The
// raw provider error text is intentionally NOT placed in `content` because that
// array is replayed back to the model on the next turn — provider error strings
// can carry hostnames or upstream metadata, and replaying them as assistant
// content opens a prompt-injection surface (CWE-200). The detailed error stays
// in the peer `errorMessage` field, which clients/UIs read directly and
// providers do not include in their wire payloads.
//
// This constant is the single source of truth used by replay normalization and
// session-file repair as well, so a session repaired offline reads identically
// to a live stream-error turn (and the repair pass remains idempotent).
export const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

// Whitespace is the only plausible separator between repeated placeholder
// occurrences. The placeholder itself contains internal spaces, so we compare
// a whitespace-stripped copy of the input against a whitespace-stripped copy
// of the constant — that turns "N copies with arbitrary whitespace between
// them" into a clean integer-multiple check.
const STREAM_ERROR_PLACEHOLDER_COMPACT = STREAM_ERROR_FALLBACK_TEXT.replace(/\s+/g, "");

/**
 * Detect text made up entirely of stream-error placeholder repetitions.
 *
 * When a primary model fails mid-stream the runtime records an assistant turn
 * with the canonical sentinel as content. If a fallback model then runs in the
 * same session, it can echo that sentinel back as its "completed" final reply
 * — sometimes a single occurrence, sometimes dozens concatenated with
 * whitespace. Because that fallback turn carries `stopReason: "stop"`, it is
 * treated as a normal user-visible response and reaches durable delivery
 * unless the dispatcher strips it. Exact-equality checks elsewhere (chat
 * display, replay history, agent prompt builder) only catch the single-copy
 * case; this helper also catches pure repetition so the fallback echo cannot
 * leak to channels as visible chat.
 *
 * The matcher is deliberately conservative: text that mixes the placeholder
 * with any other content (an apology, a partial recovery, a single literal
 * mention) is left alone. Suppressing that would risk dropping real replies
 * that happen to quote the sentinel.
 */
export function isStreamErrorPlaceholderOnlyText(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === STREAM_ERROR_FALLBACK_TEXT) {
    return true;
  }
  const compact = trimmed.replace(/\s+/g, "");
  const placeholder = STREAM_ERROR_PLACEHOLDER_COMPACT;
  if (compact.length < placeholder.length || compact.length % placeholder.length !== 0) {
    return false;
  }
  return compact === placeholder.repeat(compact.length / placeholder.length);
}

export function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessageWithZeroUsage({
      model: params.model,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      stopReason: "error",
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}
