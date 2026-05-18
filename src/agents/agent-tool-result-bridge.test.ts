import { describe, expect, it } from "vitest";
import { buildToolResultEnvelope, type ToolResultBridgeInput } from "./agent-tool-result-bridge.js";

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("buildToolResultEnvelope — error cases", () => {
  it("maps timed-out error to temporary code with retryable=true", () => {
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: true,
      isTimedOut: true,
      errorMessage: "Command timed out after 30s",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("temporary");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe("Command timed out after 30s");
    }
  });

  it("classifies ECONNRESET as temporary even when isTimedOut is false", () => {
    const input: ToolResultBridgeInput = {
      toolName: "web_fetch",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "ECONNRESET: connection reset by peer",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("temporary");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("classifies 'not found' message as not_found", () => {
    const input: ToolResultBridgeInput = {
      toolName: "read",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "File not found: /tmp/missing.txt",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("classifies 401 Unauthorized as permission_or_auth", () => {
    const input: ToolResultBridgeInput = {
      toolName: "message",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "401 Unauthorized: token expired",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_or_auth");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("classifies 'invalid parameter' as input_error", () => {
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "invalid parameter: missing required field",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("input_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("falls back to tool_bug for unrecognized error messages", () => {
    const input: ToolResultBridgeInput = {
      toolName: "write",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "unexpected crash in write handler",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tool_bug");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("synthesizes fallback message when errorMessage is undefined", () => {
    const input: ToolResultBridgeInput = {
      toolName: "nodes",
      isToolError: true,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Tool nodes failed");
    }
  });

  it("timeout takes precedence over message-based classification", () => {
    // Even if message text says 'not found', timeout wins.
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: true,
      isTimedOut: true,
      errorMessage: "not found in registry",
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("temporary");
    }
  });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("buildToolResultEnvelope — success cases", () => {
  it("uses first line of multi-line output as summary", () => {
    const input: ToolResultBridgeInput = {
      toolName: "read",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "Hello world\nSecond line\nThird line",
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("Hello world");
    }
  });

  it("prefers summaryHint over derived summary", () => {
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "some multiline\noutput here",
      summaryHint: "Command exited with code 0",
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("Command exited with code 0");
    }
  });

  it("falls back to '<toolName> completed' when no text and no hint", () => {
    const input: ToolResultBridgeInput = {
      toolName: "memory_get",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: undefined,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("memory_get completed");
    }
  });

  it("truncates a very long single-line output to at most 201 chars (200 + ellipsis)", () => {
    const longLine = "x".repeat(300);
    const input: ToolResultBridgeInput = {
      toolName: "web_search",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: longLine,
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.length).toBeLessThanOrEqual(201);
    }
  });

  it("returns empty sources array", () => {
    const input: ToolResultBridgeInput = {
      toolName: "read",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "content",
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sources).toEqual([]);
    }
  });

  it("ok result has ok: true discriminant", () => {
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "done",
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
  });

  it("strips leading whitespace from output lines when deriving summary", () => {
    const input: ToolResultBridgeInput = {
      toolName: "exec",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "   trimmed line   \nmore output",
    };
    const result = buildToolResultEnvelope(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("trimmed line");
    }
  });
});
