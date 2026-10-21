import { afterEach, assert, describe, expect, it } from "vitest";
import { configureAcpErrorRedactor } from "../error-format.js";
import {
  AcpRuntimeError,
  formatAcpErrorChain,
  isAcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "./errors.js";

const token = "sk-abcdefghijklmnopqrstuvwxyz123456";

async function expectWrappedError(source: Error, code: string) {
  try {
    await rejectThroughBoundary(source);
  } catch (error) {
    assert(error instanceof AcpRuntimeError);
    expect(error).toMatchObject({ name: "AcpRuntimeError", code, message: source.message });
    expect(error.cause).toBe(source);
    return;
  }
  throw new Error("expected ACP runtime error rejection");
}

function rejectThroughBoundary(error: unknown) {
  return withAcpRuntimeErrorBoundary({
    run: async () => {
      throw error;
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "fallback",
  });
}

afterEach(() => configureAcpErrorRedactor(undefined));

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    const sourceError = Object.assign(new Error("boom"), { data: { details: "extra diagnostic" } });
    await expectWrappedError(sourceError, "ACP_TURN_FAILED");
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(rejectThroughBoundary(existing)).rejects.toBe(existing);
  });

  it("preserves ACP runtime codes from foreign package errors", async () => {
    const foreignError = Object.assign(new Error("backend missing"), {
      code: "ACP_BACKEND_MISSING",
      data: { details: "extra backend diagnostic" },
    });
    await expectWrappedError(foreignError, "ACP_BACKEND_MISSING");
    expect(isAcpRuntimeError(foreignError)).toBe(true);
  });

  it("preserves redacted RequestError details from numeric ACP errors", () => {
    const requestError = Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: { details: `unknown config option: timeout; token=${token}` },
    });
    const error = toAcpRuntimeError({
      error: requestError,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "fallback",
    });
    expect(error.code).toBe("ACP_TURN_FAILED");
    expect(error.message).toContain("Internal error: unknown config option: timeout");
    expect(error.message).not.toContain(token);
    expect(error.cause).toBe(requestError);
  });
});

describe("formatAcpErrorChain redaction", () => {
  it("redacts secret-shaped tokens that arrive as top-level non-Error values", () => {
    const out = formatAcpErrorChain(`upstream rejected token=${token}`);
    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });

  it("redacts secret-shaped tokens that arrive in nested cause messages", () => {
    const inner = new Error(`upstream rejected token=${token}`);
    const out = formatAcpErrorChain(
      new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed", { cause: inner }),
    );
    expect(out).toMatch(/ACP_TURN_FAILED/);
    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });

  it("redacts common HTTP and private-key credentials in ACP error text", () => {
    const secrets = [
      "Authorization: Basic dXNlcjpwYXNzd29yZGFiY2RlZg==",
      "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyz\n-----END PRIVATE KEY-----",
    ];
    const out = formatAcpErrorChain(
      new AcpRuntimeError("ACP_TURN_FAILED", `backend failed: ${secrets.join(" ")}`),
    );
    for (const secret of secrets) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("backend failed");
  });

  it("uses a configured host redactor before rendering ACP error text", () => {
    configureAcpErrorRedactor((value) => value.replaceAll("custom-secret", "[CUSTOM]"));
    const out = formatAcpErrorChain(new AcpRuntimeError("ACP_TURN_FAILED", "custom-secret"));
    expect(out).toContain("[CUSTOM]");
    expect(out).not.toContain("custom-secret");
  });
});
