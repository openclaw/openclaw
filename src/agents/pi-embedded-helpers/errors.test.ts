import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  classifyFailoverAssistantReason,
  formatAssistantErrorText,
  isFailoverAssistantError,
} from "./errors.js";

describe("formatAssistantErrorText streaming JSON parse classification", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("suppresses transport-classified malformed streaming fragments", () => {
    const msg = makeAssistantError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("does not suppress unclassified JSON.parse text", () => {
    const msg = makeAssistantError(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
  });

  it("keeps non-streaming provider request-validation syntax diagnostics", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    );
  });
});

describe("assistant failover classification", () => {
  it("preserves the reason for MiniMax text-body rate-limit payloads", () => {
    const msg = makeAssistantMessageFixture({
      provider: "minimax",
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        {
          type: "text",
          text:
            "当前请求量较高，标准套餐的速率限制可能会临时收紧。" +
            "请稍后重试，或升级至 High-Speed 套餐以获得优先容量支持。 (2062)",
        },
      ],
    });

    expect(classifyFailoverAssistantReason(msg)).toBe("rate_limit");
    expect(isFailoverAssistantError(msg)).toBe(true);
  });

  it("does not scan generic successful assistant prose for failover terms", () => {
    const msg = makeAssistantMessageFixture({
      provider: "openai",
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        {
          type: "text",
          text: "A rate limit is a quota that protects a high demand service.",
        },
      ],
    });

    expect(classifyFailoverAssistantReason(msg)).toBeNull();
    expect(isFailoverAssistantError(msg)).toBe(false);
  });

  it("preserves errorMessage failover classification on non-error assistant messages", () => {
    const msg = makeAssistantMessageFixture({
      provider: "openai",
      stopReason: "length",
      errorMessage: "rate limit exceeded",
      content: [],
    });

    expect(classifyFailoverAssistantReason(msg)).toBe("rate_limit");
    expect(isFailoverAssistantError(msg)).toBe(true);
  });

  it("does not treat generic MiniMax retry copy as a text-body rate limit", () => {
    const msg = makeAssistantMessageFixture({
      provider: "minimax",
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "请稍后重试" }],
    });

    expect(classifyFailoverAssistantReason(msg)).toBeNull();
    expect(isFailoverAssistantError(msg)).toBe(false);
  });
});
