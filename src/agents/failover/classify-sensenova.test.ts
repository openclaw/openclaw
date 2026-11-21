import { describe, expect, it } from "vitest";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "../embedded-agent-helpers/assistant-message-failures.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { classifyFailoverSignalCore } from "./classify-core.js";

const minuteWindowMessage = "429 inference exceeds tpm/rpm limit";

function assistantError(body: string, code = "insufficient_quota") {
  return {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "sensenova",
    model: "deepseek-v4-flash",
    usage: createZeroUsageFixture(),
    stopReason: "error" as const,
    errorMessage: minuteWindowMessage,
    errorCode: code,
    errorType: "rate_limit_error",
    errorBody: body,
    content: [],
    timestamp: 0,
  };
}

describe("SenseNova minute-window 429", () => {
  it("classifies the observed insufficient_quota response as a rate limit", () => {
    const error = assistantError(
      '{"code":"insufficient_quota","message":"inference exceeds tpm/rpm limit","type":"rate_limit_error"}',
    );
    expect(classifyFailoverSignalCore(buildAssistantFailoverSignal(error))).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
    expect(classifyAssistantFailoverReason(error)).toBe("rate_limit");
  });

  it("keeps the earlier 429003 response classified as a rate limit", () => {
    const error = assistantError(
      '{"code":"429003","message":"inference exceeds tpm/rpm limit","type":"rate_limit_error"}',
      "429003",
    );
    expect(classifyAssistantFailoverReason(error)).toBe("rate_limit");
  });

  it("preserves independent account-balance evidence in the same response", () => {
    const error = assistantError(
      '{"code":"insufficient_quota","message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","detail":"credit balance too low"}',
    );
    expect(classifyAssistantFailoverReason(error)).toBe("billing");
  });

  it("preserves a genuine payment-required response", () => {
    expect(
      classifyFailoverSignalCore({
        status: 402,
        message: "402 credit balance too low",
        code: "insufficient_quota",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
  });

  it("does not protect a typed rate-limit response with an account-balance message", () => {
    const error = {
      ...assistantError(
        '{"code":"insufficient_quota","message":"credit balance too low","type":"rate_limit_error"}',
      ),
      errorMessage: "429 credit balance too low",
    };
    expect(classifyAssistantFailoverReason(error)).toBe("billing");
  });
});
