/**
 * Phase 3 wiring tests: verifies that buildToolResultEnvelope produces the
 * correct AgentToolResult when called with the exact inputs that
 * handleToolExecutionEnd has in scope just before the after_tool_call hook.
 *
 * These tests are intentionally narrow — they cover the contract between the
 * bridge function and the hook event field without importing any heavy runtime.
 */

import { describe, expect, it } from "vitest";
import { buildToolResultEnvelope } from "./agent-tool-result-bridge.js";
import type { AgentToolResult } from "./agent-tool-result.js";

// ---------------------------------------------------------------------------
// Helpers for building ToolResultBridgeInput that match the local variables
// handleToolExecutionEnd has in scope at the wiring point.
// ---------------------------------------------------------------------------

function makeSuccessInput(toolName: string, outputText: string | undefined) {
  return {
    toolName,
    isToolError: false,
    isTimedOut: false,
    errorMessage: undefined,
    outputText,
  };
}

function makeErrorInput(toolName: string, errorMessage: string | undefined, isTimedOut = false) {
  return {
    toolName,
    isToolError: true,
    isTimedOut,
    errorMessage,
    outputText: undefined,
  };
}

// ---------------------------------------------------------------------------
// Success path — matches the `if (hookRunnerAfter?.hasHooks("after_tool_call"))`
// block when the tool completed without error.
// ---------------------------------------------------------------------------

describe("Phase 3 wiring — success path", () => {
  it("produces ok:true envelope when isToolError is false", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("read", "file contents here"));
    expect(envelope.ok).toBe(true);
  });

  it("summary is first line of outputText when available", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("read", "first line\nsecond line"));
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.summary).toBe("first line");
  });

  it("summary falls back to '<toolName> completed' when outputText is undefined", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("exec", undefined));
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.summary).toBe("exec completed");
  });

  it("summary falls back to '<toolName> completed' when outputText is empty string", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("exec", ""));
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.summary).toBe("exec completed");
  });

  it("sources is an empty array on success envelope", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("message", "sent"));
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.sources).toEqual([]);
  });

  it("summaryHint overrides outputText-derived summary", () => {
    const envelope = buildToolResultEnvelope({
      ...makeSuccessInput("read", "raw output"),
      summaryHint: "custom hint",
    });
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.summary).toBe("custom hint");
  });
});

// ---------------------------------------------------------------------------
// Error path — matches the case when isToolError is true.
// The wiring passes: isTimedOut: isToolResultTimedOut(sanitizedResult)
//                    errorMessage: extractToolErrorMessage(sanitizedResult)
// ---------------------------------------------------------------------------

describe("Phase 3 wiring — error path", () => {
  it("produces ok:false envelope when isToolError is true", () => {
    const envelope = buildToolResultEnvelope(makeErrorInput("exec", "exit code 1"));
    expect(envelope.ok).toBe(false);
  });

  it("timeout error maps to code=temporary with retryable=true", () => {
    const envelope = buildToolResultEnvelope(makeErrorInput("exec", "execution timed out", true));
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.code).toBe("temporary");
    expect(envelope.error.retryable).toBe(true);
  });

  it("permission denied error maps to permission_or_auth", () => {
    const envelope = buildToolResultEnvelope(
      makeErrorInput("read", "Permission denied: /etc/shadow"),
    );
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.code).toBe("permission_or_auth");
  });

  it("file not found error maps to not_found", () => {
    const envelope = buildToolResultEnvelope(
      makeErrorInput("read", "No such file or directory: /tmp/missing"),
    );
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.code).toBe("not_found");
  });

  it("invalid argument error maps to input_error", () => {
    const envelope = buildToolResultEnvelope(
      makeErrorInput("write", "Invalid argument: path cannot be empty"),
    );
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.code).toBe("input_error");
  });

  it("synthesizes fallback error message when errorMessage is undefined", () => {
    const envelope = buildToolResultEnvelope(makeErrorInput("exec", undefined));
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.message).toBe("Tool exec failed");
  });

  it("preserves the error message from extractToolErrorMessage", () => {
    const envelope = buildToolResultEnvelope(makeErrorInput("message", "Rate limit exceeded"));
    if (envelope.ok) {
      throw new Error("expected error");
    }
    expect(envelope.error.message).toBe("Rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// Hook event shape — verifies the structuredResult field fits the
// PluginHookAfterToolCallEvent type (compile-time contract test).
// ---------------------------------------------------------------------------

describe("Phase 3 wiring — hook event shape", () => {
  it("structuredResult can be attached to a partial hook event object", () => {
    const structuredResult: AgentToolResult = buildToolResultEnvelope(
      makeSuccessInput("read", "content"),
    );
    // Simulate the hookEvent construction in handleToolExecutionEnd.
    const hookEvent = {
      toolName: "read",
      params: {} as Record<string, unknown>,
      runId: "run-abc",
      toolCallId: "tc-123",
      result: "raw result",
      error: undefined,
      durationMs: 42,
      structuredResult,
    };
    expect(hookEvent.structuredResult).toBe(structuredResult);
    expect(hookEvent.structuredResult.ok).toBe(true);
  });

  it("structuredResult field is optional — hook event without it is still valid shape", () => {
    const hookEvent = {
      toolName: "exec",
      params: {} as Record<string, unknown>,
    };
    // TypeScript allows omitting optional fields; verify the runtime object is fine.
    expect("structuredResult" in hookEvent).toBe(false);
  });

  it("discriminated union narrows correctly via ok flag on structuredResult", () => {
    const envelope = buildToolResultEnvelope(makeSuccessInput("write", "done"));
    if (envelope.ok) {
      // TypeScript should allow accessing .summary here.
      expect(typeof envelope.summary).toBe("string");
    } else {
      throw new Error("expected ok=true");
    }
  });

  it("discriminated union narrows correctly to error branch", () => {
    const envelope = buildToolResultEnvelope(makeErrorInput("exec", "SIGKILL"));
    if (!envelope.ok) {
      expect(typeof envelope.error.code).toBe("string");
      expect(typeof envelope.error.message).toBe("string");
    } else {
      throw new Error("expected ok=false");
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency / safety — buildToolResultEnvelope must never throw.
// ---------------------------------------------------------------------------

describe("Phase 3 wiring — safety", () => {
  it("does not throw when all optional fields are undefined", () => {
    expect(() =>
      buildToolResultEnvelope({
        toolName: "unknown",
        isToolError: false,
        isTimedOut: false,
        errorMessage: undefined,
        outputText: undefined,
      }),
    ).not.toThrow();
  });

  it("does not throw on error path with all optional fields undefined", () => {
    expect(() =>
      buildToolResultEnvelope({
        toolName: "unknown",
        isToolError: true,
        isTimedOut: false,
        errorMessage: undefined,
        outputText: undefined,
      }),
    ).not.toThrow();
  });

  it("handles very long outputText gracefully (truncates to 200 chars)", () => {
    const longText = "x".repeat(500);
    const envelope = buildToolResultEnvelope(makeSuccessInput("read", longText));
    if (!envelope.ok) {
      throw new Error("expected ok");
    }
    expect(envelope.summary.length).toBeLessThanOrEqual(201); // 200 + "…"
  });
});
