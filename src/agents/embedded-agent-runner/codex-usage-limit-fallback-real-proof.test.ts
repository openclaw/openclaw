// Real behavior proof: Codex usage-limit payloads trigger model fallback.
//
// This test exercises the production classifyEmbeddedAgentRunResultForModelFallback()
// classifier with the exact Codex subscription usage-limit error text that OpenAI
// returns when a Codex account hits its periodic usage limit.
//
// Before the fix (upstream/main): classifyBusinessDenialErrorPayloadReason() discarded
// rate_limit as an unrecognized reason, so the classifier returned null and no fallback
// was triggered.
//
// After the fix: rate_limit is an accepted classification, so the classifier returns
// a fallback-worthy result with reason "rate_limit".
import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

const CODEX_USAGE_LIMIT_ERROR_TEXT =
  "You've reached your Codex subscription usage limit. " +
  "Next reset in 32 minutes, Jun 20 at 3:44 PM EDT. " +
  "Wait until the reset time, use another Codex account if available, " +
  "or switch to another configured model/provider.";

describe("Codex usage-limit fallback real behavior proof", () => {
  it("classifies the real Codex subscription usage-limit payload shape", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: CODEX_USAGE_LIMIT_ERROR_TEXT,
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    // Before fix: result was null (rate_limit was discarded by the classifier).
    // After fix: result is a rate_limit fallback classification.
    expect(result).not.toBeNull();
    expect(result).toEqual({
      message: `openai/gpt-5.5 ended with a provider error: ${CODEX_USAGE_LIMIT_ERROR_TEXT}`,
      reason: "rate_limit",
      code: "embedded_error_payload",
      rawError: CODEX_USAGE_LIMIT_ERROR_TEXT,
    });
  });

  it("returns null for the same text when no error payload is present", () => {
    // If the usage-limit text appears as normal assistant text (not isError),
    // it should NOT trigger fallback -- the agent already delivered a response.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: false,
            text: CODEX_USAGE_LIMIT_ERROR_TEXT,
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("returns null when the session already delivered visible output", () => {
    // If the agent already produced visible output before the usage-limit error,
    // fallback should not rotate models -- the user already has a response.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: CODEX_USAGE_LIMIT_ERROR_TEXT,
          },
        ],
        meta: {
          durationMs: 42,
          finalAssistantVisibleText: "Here is help with your question...",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("triggers fallback for rate-limit text from different providers", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openrouter",
      model: "openai/gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: CODEX_USAGE_LIMIT_ERROR_TEXT,
          },
        ],
        meta: {
          durationMs: 100,
        },
      },
    });

    expect(result).toEqual({
      message: `openrouter/openai/gpt-5.5 ended with a provider error: ${CODEX_USAGE_LIMIT_ERROR_TEXT}`,
      reason: "rate_limit",
      code: "embedded_error_payload",
      rawError: CODEX_USAGE_LIMIT_ERROR_TEXT,
    });
  });
});
