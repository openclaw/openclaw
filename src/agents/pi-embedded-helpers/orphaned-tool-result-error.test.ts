import { describe, expect, it } from "vitest";
import { isOrphanedToolResultError } from "./errors.js";

describe("isOrphanedToolResultError", () => {
  it("detects the Anthropic 'unexpected tool_use_id found in tool_result' error", () => {
    expect(
      isOrphanedToolResultError(
        "messages.144.content.1: unexpected tool_use_id found in tool_result blocks: toolu_01HjX9c7NLJaBLDzyBasSkKw. Each tool_result block must have a corresponding tool_use block in the previous message.",
      ),
    ).toBe(true);
  });

  it("detects a JSON-wrapped variant", () => {
    expect(
      isOrphanedToolResultError(
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content.0: unexpected tool_use_id found in tool_result blocks: toolu_abc123"}}',
      ),
    ).toBe(true);
  });

  it("detects the 'tool_result must have a corresponding tool_use' variant", () => {
    expect(
      isOrphanedToolResultError(
        "tool_result block must have a corresponding tool_use block in the previous message",
      ),
    ).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isOrphanedToolResultError("")).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isOrphanedToolResultError("rate limit exceeded")).toBe(false);
  });

  it("returns false for generic tool errors", () => {
    expect(isOrphanedToolResultError("unknown tool: my_tool")).toBe(false);
  });
});
