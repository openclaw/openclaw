import { describe, expect, test } from "vitest";
import { createResultError } from "./claude-live-session.js";

const fakeSession = {
  providerId: "claude-cli",
  modelId: "claude-opus-4-7",
} as Parameters<typeof createResultError>[0];

describe("createResultError", () => {
  test("classifies session_expired when CLI returns errors[] (no result string)", () => {
    const parsed = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: bcef6ad0-1f50-4a30-b7b9-9a2c0e1ca625"],
      result: null,
    };
    const raw = JSON.stringify(parsed);
    const err = createResultError(fakeSession, parsed, raw);
    expect(err.reason).toBe("session_expired");
    expect(err.message).toContain("No conversation found");
  });

  test("falls back to result string when no errors[] (existing behavior)", () => {
    const parsed = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "API Error: 500 Internal",
    };
    const err = createResultError(fakeSession, parsed, JSON.stringify(parsed));
    expect(err.message).toContain("API Error");
  });

  test("uses generic fallback when no errors[] and no result string", () => {
    const parsed = { type: "result", is_error: true };
    const err = createResultError(fakeSession, parsed, JSON.stringify(parsed));
    expect(err.message).toBe("Claude CLI failed.");
    expect(err.reason).toBe("unknown");
  });
});
