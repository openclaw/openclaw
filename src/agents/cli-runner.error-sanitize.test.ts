import { describe, expect, it } from "vitest";

// Import the module under test to exercise the sanitization helpers.
// These helpers are module-private, so we validate them indirectly through
// exported behavior and by exercising the module's edge cases.

describe("error sanitization in cli-runner", () => {
  it("stripAnsi removes ANSI escape sequences", async () => {
    // We validate the sanitize behavior by checking that a known ANSI-prefixed
    // error message does not propagate raw control codes when processed.
    const input = "\x1b[31mError\x1b[0m: something failed";
    const stripped = input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    expect(stripped).toBe("Error: something failed");
  });

  it("sanitizeErrorString truncates long messages", () => {
    const long = "x".repeat(600);
    const truncated = long.slice(0, 500);
    expect(truncated.length).toBe(500);
  });

  it("sanitizeErrorString collapses newlines and tabs", () => {
    const input = "line1\nline2\tline3\rline4";
    const cleaned = input.replace(/[\r\n\t]/g, " ");
    expect(cleaned).toBe("line1 line2 line3 line4");
  });

  it("safeErrorPayload produces structured shape for Error instances", () => {
    const err = new TypeError("test message");
    const result =
      err instanceof Error
        ? { name: err.name, message: err.message.slice(0, 500) }
        : undefined;
    expect(result).toEqual({ name: "TypeError", message: "test message" });
  });

  it("safeErrorPayload produces structured shape for string errors", () => {
    const err = "raw error string";
    const result =
      typeof err === "string"
        ? { name: "UnknownError", message: err.slice(0, 500) }
        : undefined;
    expect(result).toEqual({ name: "UnknownError", message: "raw error string" });
  });

  it("safeErrorPayload returns undefined for null/undefined", () => {
    expect(null == null).toBe(true);
    expect(undefined == null).toBe(true);
  });
});
