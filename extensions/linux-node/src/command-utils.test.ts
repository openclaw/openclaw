import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { assertToolResult, formatToolError } from "./command-utils.js";

describe("linux-node command utilities", () => {
  it("keeps truncated tool errors within the limit without splitting surrogate pairs", () => {
    const result: SpawnResult = {
      stdout: "",
      stderr: `${"x".repeat(299)}\u{1f600}tail`,
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
    expect(formatToolError(result)).toBe("x".repeat(299));
    expect(() => assertToolResult(result, "TOOL_UNAVAILABLE")).toThrow(
      `TOOL_UNAVAILABLE: ${"x".repeat(299)}`,
    );
  });
});
