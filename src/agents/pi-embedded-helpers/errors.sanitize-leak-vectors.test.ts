import { describe, expect, it } from "vitest";
import {
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  AUTH_CONFIG_ERROR_MESSAGE,
} from "../pi-embedded-helpers.js";

describe("formatRawAssistantErrorForUi — leak vector sanitization", () => {
  it("strips request_id from API error payloads", () => {
    const raw =
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"},"request_id":"req_abc123"}';
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).not.toContain("req_abc123");
    expect(result).not.toContain("request_id");
  });

  it("strips HTTP status prefix from API error payloads", () => {
    const raw =
      '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_xyz"}';
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).not.toContain("req_xyz");
    expect(result).toContain("temporary error");
  });

  it("suppresses JSON payloads in fallback path", () => {
    const raw = '{"error":{"type":"unknown_type","message":"something weird","code":"ERR_123"}}';
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).not.toContain("ERR_123");
  });

  it("suppresses HTML error pages", () => {
    const raw = "502 <!DOCTYPE html><html><body>Bad Gateway nginx</body></html>";
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).not.toContain("nginx");
    expect(result).not.toContain("html");
  });

  it("suppresses long error messages that may contain internal details", () => {
    const raw = "Something went wrong: " + "a".repeat(300);
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).toContain("temporary error");
  });

  it("suppresses errors containing stack traces", () => {
    const raw = "Error: ENOENT\n    at Object.openSync (/usr/lib/node_modules/foo.js:123:45)";
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).not.toContain("ENOENT");
    expect(result).not.toContain("/usr/lib");
  });

  it("passes through short, safe error text", () => {
    const raw = "Model not available";
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).toBe("Model not available");
  });
});

describe("formatAssistantErrorText — leak vector sanitization", () => {
  it("sanitizes thinking.signature field-required errors", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.2.content.0.thinking.signature: Field required"}}',
    });
    expect(result).not.toContain("messages.2");
    expect(result).not.toContain("thinking.signature");
    expect(result).toContain("Message format error");
  });

  it("sanitizes content index path leaks in invalid_request_error", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.3.text: Invalid value"}}',
    });
    expect(result).not.toContain("messages.5");
    expect(result).toContain("format error");
  });

  it("suppresses long raw errors with stack traces", () => {
    const longError =
      "Error: connect ECONNREFUSED 127.0.0.1:3000\n" +
      "    at TCPConnectWrap.afterConnect [as oncomplete] (/node_modules/net.js:1141:16)\n".repeat(
        5,
      );
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: longError,
    });
    expect(result).not.toContain("ECONNREFUSED");
    expect(result).not.toContain("127.0.0.1");
    expect(result).toContain("temporary error");
  });

  it("suppresses errors containing request_id patterns", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Unknown error occurred (request_id: req_011CYFmpt8r8CFFmnpgGL5cQ)",
    });
    expect(result).not.toContain("req_011");
    expect(result).toContain("temporary error");
  });

  it("still shows user-friendly messages for known error types", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "rate_limit_error: too many requests 429",
    });
    expect(result).toContain("rate limit");
  });

  it("suppresses auth errors with credential details", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    });
    expect(result).not.toContain("x-api-key");
    expect(result).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  it("suppresses failover wrapper messages that leak provider/model names", () => {
    const result = formatAssistantErrorText({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        "All models failed (3): anthropic/claude-opus-4-5: rate limit | openai/gpt-4: timeout | google/gemini: 500",
    });
    expect(result).not.toContain("anthropic");
    expect(result).not.toContain("openai");
    expect(result).not.toContain("google");
    expect(result).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
});
