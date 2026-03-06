import { describe, expect, it } from "vitest";
import { isAcpJsonRpcMessage, isJsonRpcId, normalizeJsonRpcId } from "./jsonrpc.js";

describe("jsonrpc helpers", () => {
  it("validates json-rpc ids", () => {
    expect(isJsonRpcId(null)).toBe(true);
    expect(isJsonRpcId("abc")).toBe(true);
    expect(isJsonRpcId(12)).toBe(true);
    expect(isJsonRpcId(Number.NaN)).toBe(false);
    expect(isJsonRpcId({})).toBe(false);
  });

  it("normalizes json-rpc ids", () => {
    expect(normalizeJsonRpcId("abc")).toBe("abc");
    expect(normalizeJsonRpcId(12)).toBe("12");
    expect(normalizeJsonRpcId(null)).toBeNull();
    expect(normalizeJsonRpcId(undefined)).toBeNull();
  });

  it("accepts request, response, and notification shapes", () => {
    expect(
      isAcpJsonRpcMessage({
        jsonrpc: "2.0",
        method: "session/prompt",
        id: 1,
      }),
    ).toBe(true);

    expect(
      isAcpJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          stopReason: "end_turn",
        },
      }),
    ).toBe(true);

    expect(
      isAcpJsonRpcMessage({
        jsonrpc: "2.0",
        method: "session/update",
      }),
    ).toBe(true);
  });

  it("rejects malformed result/error response shapes", () => {
    expect(
      isAcpJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
      }),
    ).toBe(false);

    expect(
      isAcpJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: {
          code: -1,
          message: "bad",
        },
      }),
    ).toBe(false);
  });
});
