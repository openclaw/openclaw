import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";

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
// content opens a prompt-injection surface (CWE-200). A small allowlisted
// billing message is the exception: it is built from model metadata plus
// numeric token-budget details only, so clients that render content without
// reading `errorMessage` can still tell the operator what is wrong. The detailed
// error stays in the peer `errorMessage` field, which clients/UIs read directly
// and providers do not include in their wire payloads.
//
// This constant is the single source of truth used by replay normalization and
// session-file repair as well, so a session repaired offline reads identically
// to a live stream-error turn (and the repair pass remains idempotent).
export const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

const BILLING_ERROR_HINT_RE =
  /\b(?:billing|credits?|credit|insufficient balance|run out of credits|fewer max_tokens|can only afford)\b/i;
const AFFORDABLE_TOKEN_RE =
  /requested up to\s+([\d,]+)\s+tokens?,?\s+but can only afford\s+([\d,]+)/i;

function buildBillingStreamErrorText(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
}): string | undefined {
  const raw = params.errorMessage.trim();
  if (!raw || !BILLING_ERROR_HINT_RE.test(raw)) {
    return undefined;
  }

  const affordMatch = raw.match(AFFORDABLE_TOKEN_RE);
  const affordText = affordMatch
    ? ` Requested up to ${affordMatch[1]} tokens, but the account can only afford ${affordMatch[2]}.`
    : "";

  return `[model unavailable: billing/credits] ${params.model.provider} (${params.model.id}) cannot run with the current API key balance.${affordText} Add credits, lower maxTokens, or switch models.`;
}

export function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  const visibleText = buildBillingStreamErrorText(params) ?? STREAM_ERROR_FALLBACK_TEXT;
  return {
    ...buildAssistantMessageWithZeroUsage({
      model: params.model,
      content: [{ type: "text", text: visibleText }],
      stopReason: "error",
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}
