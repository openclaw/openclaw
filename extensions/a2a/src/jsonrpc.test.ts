/**
 * Tests for JSON-RPC 2.0 parser and formatter.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
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
    assert.strictEqual(Array.isArray(result), false);
    if (!Array.isArray(result) && !("code" in result)) {
      assert.strictEqual(result.jsonrpc, "2.0");
      assert.strictEqual(result.id, 1);
      assert.strictEqual(result.method, "tasks/send");
      assert.deepStrictEqual(result.params, { message: "hello" });
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
      assert.strictEqual(isNotification(result), true);
      assert.strictEqual(result.method, "tasks/cancel");
    }
  });

  it("rejects invalid json", () => {
    const result = parseJsonRpc("not json");
    assert.deepStrictEqual(result, JSONRPC_ERROR.PARSE_ERROR);
  });

  it("rejects missing jsonrpc version", () => {
    const result = parseJsonRpc(JSON.stringify({ id: 1, method: "test" }));
    assert.deepStrictEqual(result, JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects missing method", () => {
    const result = parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1 }));
    assert.deepStrictEqual(result, JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects non-object", () => {
    const result = parseJsonRpc("1");
    assert.deepStrictEqual(result, JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("parses a batch request", () => {
    const result = parseJsonRpc(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tasks/send" },
        { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { taskId: "x" } },
      ]),
    );
    assert.strictEqual(Array.isArray(result), true);
    if (Array.isArray(result)) {
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, 1);
      assert.strictEqual(result[1].id, 2);
    }
  });

  it("rejects batch with invalid item", () => {
    const result = parseJsonRpc(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tasks/send" },
        { invalid: true },
      ]),
    );
    assert.deepStrictEqual(result, JSONRPC_ERROR.INVALID_REQUEST);
  });

  it("rejects empty batch", () => {
    const result = parseJsonRpc("[]");
    assert.deepStrictEqual(result, JSONRPC_ERROR.INVALID_REQUEST);
  });
});

describe("formatResponse / formatError", () => {
  it("formats a success response", () => {
    const resp = formatResponse(1, { taskId: "abc", state: "working" });
    assert.strictEqual(resp.jsonrpc, "2.0");
    assert.strictEqual(resp.id, 1);
    assert.deepStrictEqual(resp.result, { taskId: "abc", state: "working" });
    assert.strictEqual("error" in resp, false);
  });

  it("formats an error response", () => {
    const resp = formatError(1, { code: -32001, message: "Task not found" });
    assert.strictEqual(resp.jsonrpc, "2.0");
    assert.strictEqual(resp.id, 1);
    assert.strictEqual(resp.error?.code, -32001);
    assert.strictEqual(resp.error?.message, "Task not found");
  });

  it("formats a notification response with null id", () => {
    const resp = formatResponse(undefined, "ok");
    assert.strictEqual(resp.id, null);
  });
});
