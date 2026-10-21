import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "./assistant-message-failures.js";

describe("classifyAssistantFailoverReason", () => {
  it("uses the recorded provider floor even when the display message was clipped", () => {
    const message = makeAssistantMessageFixture({
      errorMessage: "429: rate limited; Retry-After: 7 seconds",
      errorCode: "rate_limit_exceeded",
      retryAfterMs: 62_500,
    });
    expect(buildAssistantFailoverSignal(message).retryAfterMs).toBe(62_500);
    expect(buildAssistantFailoverSignal({ ...message, retryAfterMs: null }).retryAfterMs).toBe(
      Infinity,
    );
    const billing = {
      ...message,
      errorMessage: "402: account balance exhausted",
      errorCode: "insufficient_quota",
    };
    expect(classifyAssistantFailoverReason(billing, { providerOwner: null })).toBe("billing");
  });
  const opencodeGoStalledStreamError = makeAssistantMessageFixture({
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    content: [],
  });

  it("classifies opencode-go provider-owned stalled streams as timeout", () => {
    expect(classifyAssistantFailoverReason(opencodeGoStalledStreamError)).toBe("timeout");
  });

  it.each([
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])("classifies structured %s assistant errors as timeouts", (errorCode) => {
    const message = {
      ...opencodeGoStalledStreamError,
      provider: "demo-provider",
      errorCode,
      errorMessage: "provider connection closed",
    };
    expect(classifyAssistantFailoverReason(message)).toBe("timeout");
  });

  it.each([400, 401, 402, 403, 404])(
    "does not classify malformed tool arguments of length %s as auth failures",
    (argumentChars) => {
      const message = makeAssistantMessageFixture({
        provider: "anthropic",
        errorMessage: "Provider completed tool call with malformed JSON arguments",
        errorCode: "malformed_tool_call_arguments",
        errorBody: JSON.stringify({
          code: "malformed_tool_call_arguments",
          argumentChars,
          argumentHash: "synthetic-hash",
          repairAttempted: true,
        }),
        content: [],
      });
      expect(classifyAssistantFailoverReason(message, { providerOwner: null })).toBeNull();
    },
  );

  it("does not classify caller-aborted assistant messages as provider failover", () => {
    const message = { ...opencodeGoStalledStreamError, stopReason: "aborted" as const };
    expect(classifyAssistantFailoverReason(message)).toBeNull();
  });

  it("uses structured assistant error bodies for model-not-found 400s", () => {
    const message = makeAssistantMessageFixture({
      api: "openai-completions",
      model: "some-model-id",
      errorMessage: "400 Param Incorrect",
      errorCode: "400",
      errorBody:
        '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
      content: [],
    });
    expect(classifyAssistantFailoverReason(message)).toBe("model_not_found");
  });
});
