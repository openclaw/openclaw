type CompletionsChunkLike = {
  usage?: unknown;
  choices?: unknown;
};

type CompletionsChoiceLike = {
  finish_reason?: unknown;
  usage?: unknown;
  delta?: unknown;
  message?: unknown;
};

/**
 * Whether a parsed completions chunk carries model progress (delta content, hidden reasoning,
 * tool calls, a finish reason or usage). Keepalive-style chunks with empty choices or empty
 * deltas are not progress and must not re-arm the LLM idle watchdog.
 */
export function hasOpenAICompletionsChunkProgress(chunk: CompletionsChunkLike): boolean {
  if (chunk.usage) {
    return true;
  }
  const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as
    | CompletionsChoiceLike
    | undefined;
  if (!choice) {
    return false;
  }
  if (choice.finish_reason || choice.usage) {
    return true;
  }
  const delta = choice.delta ?? choice.message;
  if (!delta || typeof delta !== "object") {
    return false;
  }
  return Object.entries(delta as Record<string, unknown>).some(
    ([key, value]) => key !== "role" && hasNonEmptyDeltaValue(value),
  );
}

function hasNonEmptyDeltaValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}
