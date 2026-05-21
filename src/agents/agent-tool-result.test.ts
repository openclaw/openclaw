import { describe, expect, it } from "vitest";
import {
  classifyToolError,
  isRetryableErrorCode,
  serializeToolResult,
  wrapToolError,
  wrapToolOk,
  type AgentToolResult,
} from "./agent-tool-result.js";

describe("wrapToolOk", () => {
  it("produces ok: true envelope with required fields", () => {
    const result = wrapToolOk({
      summary: "Found 3 records",
      data: { count: 3 },
      sources: ["https://example.com"],
      next_hint: "Use the count to decide next step",
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Found 3 records");
    expect(result.data).toEqual({ count: 3 });
    expect(result.sources).toEqual(["https://example.com"]);
    expect(result.next_hint).toBe("Use the count to decide next step");
  });

  it("defaults sources to empty array", () => {
    const result = wrapToolOk({ summary: "done", data: null });
    expect(result.sources).toEqual([]);
  });

  it("allows omitting next_hint", () => {
    const result = wrapToolOk({ summary: "done", data: null });
    expect(result.next_hint).toBeUndefined();
  });
});

describe("wrapToolError", () => {
  it("produces ok: false envelope with error fields", () => {
    const result = wrapToolError({
      code: "not_found",
      message: "Document not found",
      retryable: false,
      next_hint: "Check the document ID",
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("not_found");
    expect(result.error.message).toBe("Document not found");
    expect(result.error.retryable).toBe(false);
    expect(result.next_hint).toBe("Check the document ID");
  });

  it("allows partial_data for partial results before failure", () => {
    const result = wrapToolError({
      code: "temporary",
      message: "Timeout after 3 records",
      retryable: true,
      partial_data: { records: [1, 2, 3] },
    });
    expect(result.partial_data).toEqual({ records: [1, 2, 3] });
  });
});

describe("classifyToolError", () => {
  const cases: Array<[string | Error, string]> = [
    ["timeout after 30s", "temporary"],
    ["ECONNRESET", "temporary"],
    ["network unavailable", "temporary"],
    ["503 Service Unavailable", "temporary"],
    ["not found", "not_found"],
    ["404 Not Found", "not_found"],
    ["does not exist", "not_found"],
    ["Forbidden 403", "permission_or_auth"],
    ["401 Unauthorized", "permission_or_auth"],
    ["invalid parameter: missing field", "input_error"],
    ["bad request 400", "input_error"],
    ["schema validation failed", "input_error"],
    [new Error("unexpected internal crash"), "tool_bug"],
    ["some random weird error", "tool_bug"],
  ];

  it.each(cases)("classifies %s as %s", (input, expected) => {
    expect(classifyToolError(input)).toBe(expected);
  });

  it("handles Error objects", () => {
    expect(classifyToolError(new Error("connection timeout"))).toBe("temporary");
  });

  it("handles unknown shapes", () => {
    expect(classifyToolError({ code: 500 })).toBe("tool_bug");
  });
});

describe("isRetryableErrorCode", () => {
  it("marks temporary as retryable", () => {
    expect(isRetryableErrorCode("temporary")).toBe(true);
  });

  it.each(["input_error", "permission_or_auth", "not_found", "tool_bug"] as const)(
    "marks %s as not retryable",
    (code) => {
      expect(isRetryableErrorCode(code)).toBe(false);
    },
  );
});

describe("serializeToolResult", () => {
  it("serializes ok result to parseable JSON", () => {
    const result: AgentToolResult = wrapToolOk({ summary: "test", data: { x: 1 } });
    const parsed = JSON.parse(serializeToolResult(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.x).toBe(1);
  });

  it("serializes error result with ok: false", () => {
    const result: AgentToolResult = wrapToolError({
      code: "temporary",
      message: "timeout",
      retryable: true,
    });
    const parsed = JSON.parse(serializeToolResult(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("temporary");
    expect(parsed.error.retryable).toBe(true);
  });
});

describe("discriminated union narrowing", () => {
  it("narrows to AgentToolResultOk when ok is true", () => {
    const result: AgentToolResult<{ n: number }> = wrapToolOk({
      summary: "ok",
      data: { n: 42 },
    });
    if (result.ok) {
      // TypeScript narrows result.data here
      expect(result.data.n).toBe(42);
    } else {
      throw new Error("Expected ok result");
    }
  });

  it("narrows to AgentToolResultError when ok is false", () => {
    const result: AgentToolResult = wrapToolError({
      code: "not_found",
      message: "not found",
      retryable: false,
    });
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    } else {
      throw new Error("Expected error result");
    }
  });
});
