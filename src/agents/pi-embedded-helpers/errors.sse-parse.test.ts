import { describe, expect, it } from "vitest";
import { isLikelySSEParseError } from "./errors.js";

describe("isLikelySSEParseError", () => {
  // -----------------------------------------------------------------------
  // 基础边界情况
  // -----------------------------------------------------------------------
  it("returns false for empty string", () => {
    expect(isLikelySSEParseError("")).toBe(false);
  });

  it("returns false for generic error without streaming context", () => {
    expect(isLikelySSEParseError("something went wrong")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // SDK 特有 SSE 解析错误模式
  // -----------------------------------------------------------------------
  describe("Anthropic/OpenAI SDK patterns", () => {
    it("detects 'Could not parse SSE event'", () => {
      expect(isLikelySSEParseError("Could not parse SSE event")).toBe(true);
    });

    it("detects 'Could not process SSE event'", () => {
      expect(isLikelySSEParseError("Could not process SSE event")).toBe(true);
    });

    it("detects 'SSE parse error'", () => {
      expect(isLikelySSEParseError("SSE parse error: unexpected end of input")).toBe(true);
    });

    it("detects 'SSE parsing error'", () => {
      expect(isLikelySSEParseError("SSE parsing error on chunk")).toBe(true);
    });

    it("detects 'unexpected SSE'", () => {
      expect(isLikelySSEParseError("unexpected SSE format in response")).toBe(true);
    });

    it("detects 'malformed SSE'", () => {
      expect(isLikelySSEParseError("malformed SSE data line")).toBe(true);
    });

    it("detects 'invalid SSE'", () => {
      expect(isLikelySSEParseError("invalid SSE event received")).toBe(true);
    });

    it("detects SDK patterns without streamingContext flag", () => {
      // SDK 特有模式不需要 streamingContext 标记
      expect(isLikelySSEParseError("Could not parse SSE event", {})).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // SyntaxError + JSON context + streaming context
  // -----------------------------------------------------------------------
  describe("SyntaxError + JSON + streaming context", () => {
    it("detects SyntaxError with JSON and explicit streaming context", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("detects syntax error with unexpected end of input in streaming context", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected end of JSON input", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("detects syntax error with unterminated string in streaming context", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unterminated string in JSON", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("does NOT detect SyntaxError + JSON without streaming context", () => {
      expect(isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0")).toBe(
        false,
      );
    });

    it("detects SyntaxError + JSON with streaming stack trace", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0", {
          stack: "at fromSSE (node_modules/openai/streaming.js:123:45)",
        }),
      ).toBe(true);
    });

    it("detects via anthropic/streaming in stack", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected token in JSON", {
          stack: "at parse (node_modules/@anthropic-ai/sdk/anthropic/streaming.js:50:10)",
        }),
      ).toBe(true);
    });

    it("detects via openai/streaming in stack", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected end of JSON input", {
          stack: "at processChunk (node_modules/openai/streaming.js:99:5)",
        }),
      ).toBe(true);
    });

    it("detects via /sse/ in stack with JSON context", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected token in JSON", {
          stack: "at handleEvent (/app/lib/sse/parser.js:10:5)",
        }),
      ).toBe(true);
    });

    it("does NOT detect via /sse/ in stack when streamingContext is explicitly false and no JSON hint", () => {
      // 注意："Unexpected token" 本身不包含 JSON 关键词，
      // 但 stack 中有 /sse/ 会被视为 streaming context。
      // 带有 "SyntaxError" + "unexpected token"（含 JSON 上下文）+ stack 中有 SSE = 检测到
      // 要排除的是：没有 isSyntaxError/isJsonContext 时不触发
      expect(
        isLikelySSEParseError("generic network error", {
          stack: "at handleEvent (/app/lib/sse/parser.js:10:5)",
        }),
      ).toBe(false);
    });

    it("detects via stream. in stack", () => {
      expect(
        isLikelySSEParseError("SyntaxError: Unexpected token in JSON", {
          stack: "at stream.processLine (index.js:42:3)",
        }),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 通用 JSON parse failure + streaming context
  // -----------------------------------------------------------------------
  describe("generic JSON parse failure + streaming context", () => {
    it("detects JSON.parse failure in streaming context", () => {
      expect(
        isLikelySSEParseError("JSON.parse: unexpected character at line 1 column 1", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("detects 'json parse error' in streaming context", () => {
      expect(
        isLikelySSEParseError("json parse error: invalid data", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("detects 'failed to parse' JSON in streaming context", () => {
      expect(
        isLikelySSEParseError("Failed to parse response JSON from SSE stream", {
          streamingContext: true,
        }),
      ).toBe(true);
    });

    it("does NOT detect generic JSON parse failure without streaming context", () => {
      expect(isLikelySSEParseError("JSON.parse: unexpected character")).toBe(false);
    });

    it("detects parse error + json via streaming stack", () => {
      expect(
        isLikelySSEParseError("parse error: unexpected token in json", {
          stack: "at _sse.processEvent (lib/index.js:5:5)",
        }),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 误报排除
  // -----------------------------------------------------------------------
  describe("false positive exclusions", () => {
    it("rejects context overflow errors", () => {
      expect(
        isLikelySSEParseError("SyntaxError: context overflow: JSON at position 0", {
          streamingContext: true,
        }),
      ).toBe(false);
    });

    it("rejects context window errors", () => {
      expect(
        isLikelySSEParseError("context window exceeded while parsing JSON", {
          streamingContext: true,
        }),
      ).toBe(false);
    });

    it("rejects rate limit errors", () => {
      expect(
        isLikelySSEParseError("rate limit exceeded, JSON parse failed", {
          streamingContext: true,
        }),
      ).toBe(false);
    });

    it("rejects billing errors", () => {
      expect(
        isLikelySSEParseError("billing: insufficient credit, SSE parse error", {
          streamingContext: true,
        }),
      ).toBe(false);
    });

    it("rejects insufficient balance errors", () => {
      expect(isLikelySSEParseError("insufficient balance - Could not parse SSE event")).toBe(false);
    });

    it("rejects quota exceeded errors", () => {
      expect(isLikelySSEParseError("quota exceeded, malformed SSE")).toBe(false);
    });

    it("rejects upstream errors", () => {
      expect(isLikelySSEParseError("upstream server error, SSE parse error")).toBe(false);
    });

    it("rejects context length errors", () => {
      expect(
        isLikelySSEParseError("context length exceeded in JSON stream", {
          streamingContext: true,
        }),
      ).toBe(false);
    });

    it("rejects 'too many requests' errors", () => {
      expect(isLikelySSEParseError("too many requests, SSE parse error")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 不相关的错误不触发
  // -----------------------------------------------------------------------
  describe("unrelated errors", () => {
    it("rejects generic network errors", () => {
      expect(isLikelySSEParseError("ECONNRESET")).toBe(false);
    });

    it("rejects timeout errors", () => {
      expect(isLikelySSEParseError("Request timed out")).toBe(false);
    });

    it("rejects auth errors", () => {
      expect(isLikelySSEParseError("401 Unauthorized")).toBe(false);
    });

    it("rejects model not found errors", () => {
      expect(isLikelySSEParseError("model not found")).toBe(false);
    });

    it("rejects regular JSON errors without streaming context", () => {
      expect(isLikelySSEParseError("SyntaxError: Unexpected token in JSON")).toBe(false);
    });
  });
});
