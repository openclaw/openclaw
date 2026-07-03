/**
 * Tests for JSON-RPC 2.0 parser and formatter.
 */
import { describe, it, expect } from "vitest";
import {
  parseJsonRpc,
  formatResponse,
  formatError,
  isNotification,
  JSONRPC_ERROR,
} from "./jsonrpc.js";

describe("parseJsonRpc", () => {
  it("parses a valid request", () => {
    const result = parseJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: { message: "hello" },
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result) && !("code" in result)) {
      expect(result.jsonrpc).toBe("2.0");
      expect(result.id).toBe(1);
      expect(result.method).toBe("tasks/send");
      expect(result.params).toEqual({ message: "hello" });
    }
  });

  it("parses a notification (no id)", () => {
    const result = parseJsonRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: { taskId: "abc" },
      }),
    );

    if (!Array.isArray(result) && !("code" in result)) {
      expect(isNotification(result)).toBe(true);
      expect(result.method).toBe("tasks/cancel");
    }
  });

  it("rejects invalid json", () => {
    const result = parseJsonRpc("not json");
    expect(result).toEqual(JSONRPC_ERROR.PARSE_ERROR);
  });

  it("rejects missing jsonrpc version", () => {
    const result = parseJsonRpc(
      JSON.stringify({ id: 1, method: "test" }),
    );
    expect(result).toEqual(JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects missing method", () => {
    const result = parseJsonRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    );
    expect(result).toEqual(JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects non-object", () => {
    const result = parseJsonRpc("1");
    expect(result).toEqual(JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("parses a batch request", () => {
    const result = parseJsonRpc(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tasks/send" },
        { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { taskId: "x" } },
      ]),
    );

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    }
  });

  it("rejects batch with invalid item", () => {
    const result = parseJsonRpc(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tasks/send" },
        { invalid: true },
      ]),
    );
    expect(result).toEqual(JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects empty batch", () => {
    const result = parseJsonRpc("[]");
    expect(result).toEqual(JSONRPC_ERROR.INVALID_REQUEST);
  });
});

describe("formatResponse / formatError", () => {
  it("formats a success response", () => {
    const resp = formatResponse(1, { taskId: "abc", state: "working" });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ taskId: "abc", state: "working" });
    expect(resp.error).toBeUndefined();
  });

  it("formats an error response", () => {
    const resp = formatError(1, {
      code: -32001,
      message: "Task not found",
    });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toBe("Task not found");
  });

  it("formats a notification response with null id", () => {
    const resp = formatResponse(undefined, "ok");
    expect(resp.id).toBeNull();
  });
});
