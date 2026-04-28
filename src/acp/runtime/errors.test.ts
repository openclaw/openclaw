import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  describeAcpRpcError,
  extractAcpRpcError,
  isAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "./errors.js";

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw new Error("boom");
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: "boom",
    });
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw existing;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toBe(existing);
  });

  it("preserves ACP runtime codes from foreign package errors", async () => {
    class ForeignAcpRuntimeError extends Error {
      readonly code = "ACP_BACKEND_MISSING" as const;
    }

    const foreignError = new ForeignAcpRuntimeError("backend missing");

    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw foreignError;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_BACKEND_MISSING",
      message: "backend missing",
      cause: foreignError,
    });

    expect(isAcpRuntimeError(foreignError)).toBe(true);
  });
});

describe("extractAcpRpcError", () => {
  it("returns the payload when the value is itself a JSON-RPC error", () => {
    const payload = extractAcpRpcError({
      code: -32603,
      message: "Internal error",
      data: { details: "Unknown config option: timeout" },
    });
    expect(payload).toEqual({
      code: -32603,
      message: "Internal error",
      data: { details: "Unknown config option: timeout" },
    });
  });

  it("walks .error to find the payload", () => {
    const payload = extractAcpRpcError({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    });
    expect(payload).toMatchObject({ code: -32601, message: "Method not found" });
  });

  it("walks .acp to find the payload", () => {
    const payload = extractAcpRpcError({
      acp: { code: -32602, message: "Invalid params" },
    });
    expect(payload).toMatchObject({ code: -32602, message: "Invalid params" });
  });

  it("walks .cause recursively", () => {
    const inner = { code: -32603, message: "Internal error" };
    const outer = new Error("wrapped", { cause: { cause: inner } });
    expect(extractAcpRpcError(outer)).toMatchObject(inner);
  });

  it("stops at depth 5 to avoid pathological cycles", () => {
    const deeplyNested: Record<string, unknown> = { code: -32603, message: "deep" };
    let cursor: Record<string, unknown> = { cause: deeplyNested };
    for (let i = 0; i < 10; i += 1) {
      cursor = { cause: cursor };
    }
    expect(extractAcpRpcError(cursor)).toBeUndefined();
  });

  it("returns undefined for non-JSON-RPC shapes", () => {
    expect(extractAcpRpcError("not an object")).toBeUndefined();
    expect(extractAcpRpcError(null)).toBeUndefined();
    expect(extractAcpRpcError({ code: "not-a-number", message: "foo" })).toBeUndefined();
    expect(extractAcpRpcError({ code: 5 })).toBeUndefined();
  });
});

describe("describeAcpRpcError", () => {
  it("prefers data.details over message when both are present", () => {
    expect(
      describeAcpRpcError({
        code: -32603,
        message: "Internal error",
        data: { details: "Unknown config option: timeout" },
      }),
    ).toBe("Unknown config option: timeout (acp -32603)");
  });

  it("falls back to message when data.details is missing", () => {
    expect(describeAcpRpcError({ code: -32601, message: "Method not found" })).toBe(
      "Method not found (acp -32601)",
    );
  });

  it("falls back to err.message when no payload can be extracted", () => {
    expect(describeAcpRpcError(new Error("ECONNRESET"))).toBe("ECONNRESET");
  });
});
