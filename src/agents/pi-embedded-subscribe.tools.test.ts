import { describe, expect, it } from "vitest";
import { extractToolErrorMessage, isToolResultError } from "./pi-embedded-subscribe.tools.js";

describe("isToolResultError", () => {
  it("detects status-based errors", () => {
    expect(isToolResultError({ details: { status: "error" } })).toBe(true);
    expect(isToolResultError({ details: { status: "timeout" } })).toBe(true);
  });

  it("ignores non-error status values", () => {
    expect(isToolResultError({ details: { status: "ok" } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed" } })).toBe(false);
  });

  it("detects content-level errors starting with Error: for MCP results", () => {
    expect(
      isToolResultError({
        content: [{ type: "text", text: "Error: something failed" }],
        details: { mcpServer: "test-server" },
      }),
    ).toBe(true);
    expect(
      isToolResultError({
        content: [{ type: "text", text: "Error:" }],
        details: { mcpTool: "test_tool" },
      }),
    ).toBe(true);
  });

  it("does not flag content Error: for non-MCP results", () => {
    expect(
      isToolResultError({ content: [{ type: "text", text: "Error: something failed" }] }),
    ).toBe(false);
  });

  it("does not false-positive on mid-text Error: in MCP results", () => {
    expect(
      isToolResultError({
        content: [{ type: "text", text: "This is not Error: blah" }],
        details: { mcpServer: "test-server" },
      }),
    ).toBe(false);
  });

  it("ignores multi-line MCP content starting with Error:", () => {
    expect(
      isToolResultError({
        content: [{ type: "text", text: "Error: connection refused\nRetry in 5s\nStack trace..." }],
        details: { mcpServer: "test-server" },
      }),
    ).toBe(false);
  });

  it("ignores multi-block MCP content where joined text starts with Error:", () => {
    expect(
      isToolResultError({
        content: [
          { type: "text", text: "Error: partial output" },
          { type: "text", text: "More data follows" },
        ],
        details: { mcpServer: "test-server" },
      }),
    ).toBe(false);
  });

  it("returns false for normal MCP content", () => {
    expect(
      isToolResultError({
        content: [{ type: "text", text: "Success" }],
        details: { mcpServer: "test-server" },
      }),
    ).toBe(false);
  });

  it("returns false for missing or empty input", () => {
    expect(isToolResultError({})).toBe(false);
    expect(isToolResultError(null)).toBe(false);
    expect(isToolResultError(undefined)).toBe(false);
  });
});

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });
});
