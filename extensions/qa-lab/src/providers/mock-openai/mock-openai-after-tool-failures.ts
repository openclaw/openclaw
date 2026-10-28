import type { MockScenarioState, QaMockProviderFailure } from "./mock-openai-contracts.js";

const QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE = /provider http 503 after tool qa check/i;
const QA_PROVIDER_HTTP_429_AFTER_TOOL_PROMPT_RE = /provider http 429 after tool qa check/i;

/** Scripts a provider HTTP failure on a request that carries a tool result. */
export function resolveAfterToolHttpFailure(
  text: string,
  hasToolOutput: boolean,
  state: MockScenarioState,
): QaMockProviderFailure | undefined {
  if (!hasToolOutput) {
    return undefined;
  }
  if (QA_PROVIDER_HTTP_503_AFTER_TOOL_PROMPT_RE.test(text)) {
    return {
      status: 503,
      type: "server_error",
      message: "Service Unavailable",
      retryAfterSeconds: 120,
    };
  }
  // One OpenAI tokens-per-minute limit on the first tool continuation; the retry succeeds.
  if (QA_PROVIDER_HTTP_429_AFTER_TOOL_PROMPT_RE.test(text) && !state.rateLimitAfterToolInjected) {
    state.rateLimitAfterToolInjected = true;
    return {
      status: 429,
      type: "tokens",
      code: "rate_limit_exceeded",
      message: "Rate limit reached for QA tokens per min (TPM). Please try again in 10ms.",
      retryAfterMs: 10,
    };
  }
  return undefined;
}
