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
  it.each([undefined, "ACP_BACKEND_MISSING"])("wraps errors with source code %s", async (code) => {
    const source = Object.assign(new Error("boom"), {
      code,
      data: { details: "extra diagnostic" },
    });
    const promise = rejectThroughBoundary(source);
    await expect(promise).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: code ?? "ACP_TURN_FAILED",
      message: "boom",
    });
    const error = await promise.catch((caught: unknown) => caught);
    assert(error instanceof AcpRuntimeError);
    expect(error.cause).toBe(source);
    if (code) {
      expect(isAcpRuntimeError(source)).toBe(true);
    }
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(rejectThroughBoundary(existing)).rejects.toBe(existing);
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
  it.each([false, true])("redacts secret-shaped tokens (nested cause: %s)", (nested) => {
    const message = `upstream rejected token=${token}`;
    const source = nested
      ? new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed", { cause: new Error(message) })
      : message;
    const out = formatAcpErrorChain(source);
    if (nested) {
      expect(out).toMatch(/ACP_TURN_FAILED/);
    }
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
