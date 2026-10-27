export function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Transports for these APIs record the provider's response id once it accepts a request.
const ACKNOWLEDGING_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
]);

/**
 * True when a failed assistant turn without output reported no usage because the provider did
 * no billable work: it answered with an error body (it rejected or failed the request) or never
 * acknowledged it. Such a turn costs nothing. A turn dropped after the provider accepted it may
 * have billed hidden reasoning, so its usage stays unavailable.
 */
export function isUnbilledFailedTurn(message: {
  api?: unknown;
  stopReason?: unknown;
  content?: unknown;
  responseId?: unknown;
  errorBody?: unknown;
  usage?: { output?: number; usageReport?: { state?: unknown } };
}): boolean {
  return (
    message.stopReason === "error" &&
    message.usage?.usageReport?.state === "unavailable" &&
    (message.usage.output ?? 0) === 0 &&
    (Array.isArray(message.content) ? message.content.length === 0 : !message.content) &&
    (Boolean(message.errorBody) ||
      (!message.responseId &&
        typeof message.api === "string" &&
        ACKNOWLEDGING_APIS.has(message.api)))
  );
}

// Transports for these APIs keep streamed output on a failed turn; others drop partial tool calls.
const OUTPUT_KEEPING_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-chatgpt-responses",
]);

/**
 * Reads the same rule from a stored turn, after transport cleanup. An empty stored turn proves
 * that nothing was generated only when its transport keeps streamed output, or when the provider
 * never accepted the request.
 */
export function isUnbilledStoredFailedTurn(message: Parameters<typeof isUnbilledFailedTurn>[0]) {
  return (
    isUnbilledFailedTurn(message) &&
    typeof message.api === "string" &&
    (OUTPUT_KEEPING_APIS.has(message.api) ||
      (ACKNOWLEDGING_APIS.has(message.api) && !message.responseId))
  );
}
