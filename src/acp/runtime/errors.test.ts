import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  formatAcpErrorChain,
  isAcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "./errors.js";

async function expectRejectedAcpRuntimeError(promise: Promise<unknown>): Promise<AcpRuntimeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AcpRuntimeError);
    return error as AcpRuntimeError;
  }
  throw new Error("expected ACP runtime error rejection");
}

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    const sourceError = new Error("boom");

    const error = await expectRejectedAcpRuntimeError(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw sourceError;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    );

    expect(error.name).toBe("AcpRuntimeError");
    expect(error.code).toBe("ACP_TURN_FAILED");
    expect(error.message).toBe("boom");
    expect(error.cause).toBe(sourceError);
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
      readonly data = { details: "backend package was not installed" };
    }

    const foreignError = new ForeignAcpRuntimeError("backend missing");

    const error = await expectRejectedAcpRuntimeError(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw foreignError;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    );

    expect(error.name).toBe("AcpRuntimeError");
    expect(error.code).toBe("ACP_BACKEND_MISSING");
    expect(error.message).toBe("backend missing: backend package was not installed");
    expect(error.cause).toBe(foreignError);
    expect(isAcpRuntimeError(foreignError)).toBe(true);
  });

  it("surfaces details from numeric ACP JSON-RPC errors", () => {
    const sourceError = new Error("Internal error") as Error & {
      code: number;
      data: { details: string };
    };
    sourceError.name = "RequestError";
    sourceError.code = -32603;
    sourceError.data = { details: "unknown config option: timeout" };

    const error = toAcpRuntimeError({
      error: sourceError,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "fallback",
    });

    expect(error.name).toBe("AcpRuntimeError");
    expect(error.code).toBe("ACP_TURN_FAILED");
    expect(error.message).toBe("Internal error: unknown config option: timeout");
    expect(error.cause).toBe(sourceError);
  });
});

describe("formatAcpErrorChain redaction", () => {
  it("redacts secret-shaped tokens that arrive as top-level non-Error values", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";

    const out = formatAcpErrorChain(`upstream rejected token=${token}`);

    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });

  it("redacts secret-shaped tokens that arrive in nested cause messages", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const inner = new Error(`upstream rejected token=${token}`);
    const acp = new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed", { cause: inner });

    const out = formatAcpErrorChain(acp);

    expect(out).toMatch(/ACP_TURN_FAILED/);
    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });
});
