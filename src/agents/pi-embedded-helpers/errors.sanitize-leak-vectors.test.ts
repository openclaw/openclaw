import type { AssistantMessage } from "@mariozechner/pi-ai";
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

  it("does not suppress short safe errors containing common words like and/or", () => {
    const raw = "read/write permission denied";
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).toBe("read/write permission denied");
  });

  it("passes through short, safe error text", () => {
    const raw = "Model not available";
    const result = formatRawAssistantErrorForUi(raw);
    expect(result).toBe("Model not available");
  });
});

describe("formatAssistantErrorText — leak vector sanitization", () => {
  /** Helper to build a minimal AssistantMessage stub for error-path tests. */
  function errMsg(errorMessage: string): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage,
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    };
  }

  it("sanitizes thinking.signature field-required errors", () => {
    const result = formatAssistantErrorText(
      errMsg(
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.2.content.0.thinking.signature: Field required"}}',
      ),
    );
    expect(result).not.toContain("messages.2");
    expect(result).not.toContain("thinking.signature");
    expect(result).toContain("Message format error");
  });

  it("sanitizes content index path leaks in invalid_request_error", () => {
    const result = formatAssistantErrorText(
      errMsg(
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.3.text: Invalid value"}}',
      ),
    );
    expect(result).not.toContain("messages.5");
    expect(result).toContain("format error");
  });

  it("suppresses long raw errors with stack traces", () => {
    const longError =
      "Error: connect ECONNREFUSED 127.0.0.1:3000\n" +
      "    at TCPConnectWrap.afterConnect [as oncomplete] (/node_modules/net.js:1141:16)\n".repeat(
        5,
      );
    const result = formatAssistantErrorText(errMsg(longError));
    expect(result).not.toContain("ECONNREFUSED");
    expect(result).not.toContain("127.0.0.1");
    expect(result).toContain("temporary error");
  });

  it("suppresses errors containing request_id patterns", () => {
    const result = formatAssistantErrorText(
      errMsg("Unknown error occurred (request_id: req_011CYFmpt8r8CFFmnpgGL5cQ)"),
    );
    expect(result).not.toContain("req_011");
    expect(result).toContain("temporary error");
  });

  it("still shows user-friendly messages for known error types", () => {
    const result = formatAssistantErrorText(errMsg("rate_limit_error: too many requests 429"));
    expect(result).toContain("rate limit");
  });

  it("suppresses auth errors with credential details", () => {
    const result = formatAssistantErrorText(
      errMsg(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    );
    expect(result).not.toContain("x-api-key");
    expect(result).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  it("suppresses SSE/JSON parse errors from streaming (#14321)", () => {
    const result = formatAssistantErrorText(
      errMsg(
        "Bad control character in string literal in JSON at position 4567 (line 1 column 4568)",
      ),
    );
    expect(result).not.toContain("position 4567");
    expect(result).toContain("temporary error");
  });

  it("suppresses orphaned tool call errors after compaction (#16948)", () => {
    const result = formatAssistantErrorText(
      errMsg(
        "No tool call found for function call output with call_id toolu01QevQjBAp63b1ujgzW6SqjR.",
      ),
    );
    expect(result).not.toContain("toolu01");
    expect(result).not.toContain("call_id");
    expect(result).toContain("format error");
  });

  it("suppresses failover wrapper messages that leak provider/model names", () => {
    const result = formatAssistantErrorText(
      errMsg(
        "All models failed (3): anthropic/claude-opus-4-5: rate limit | openai/gpt-4: timeout | google/gemini: 500",
      ),
    );
    expect(result).not.toContain("anthropic");
    expect(result).not.toContain("openai");
    expect(result).not.toContain("google");
    expect(result).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
});
