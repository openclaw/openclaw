import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  describeAcpErrorForLog,
  normalizeAcpDiagnosticText,
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
});

describe("normalizeAcpDiagnosticText", () => {
  it("normalizes diagnostic text and truncates long values", () => {
    expect(normalizeAcpDiagnosticText("  hello  ")).toBe("hello");
    expect(normalizeAcpDiagnosticText("")).toBeUndefined();
    expect(normalizeAcpDiagnosticText("abcdef", 4)).toBe("abcd...");
    expect(normalizeAcpDiagnosticText(42)).toBeUndefined();
    expect(normalizeAcpDiagnosticText(null)).toBeUndefined();
  });
});

describe("describeAcpErrorForLog", () => {
  it("extracts nested stderr/stdout diagnostics for logs", () => {
    const cause = new Error("child failure") as Error & {
      code?: string;
      stderr?: string;
      stdout?: string;
      details?: { stderr?: string };
    };
    cause.code = "ACP_CHILD_FAILED";
    cause.stderr = "stderr details";
    cause.stdout = "stdout details";
    cause.details = { stderr: "deep stderr" };

    const top = new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "top level", { cause });
    const text = describeAcpErrorForLog(top);

    expect(text).toContain("error.name=AcpRuntimeError");
    expect(text).toContain("error.code=ACP_SESSION_INIT_FAILED");
    expect(text).toContain('error.message="top level"');
    expect(text).toContain("cause1.code=ACP_CHILD_FAILED");
    expect(text).toContain('cause1.stderr="stderr details"');
    expect(text).toContain('cause1.stdout="stdout details"');
    expect(text).toContain('cause1.details.stderr="deep stderr"');
  });

  it("preserves plain string causes", () => {
    const error = new Error("top level", { cause: "timeout waiting for socket" });
    const text = describeAcpErrorForLog(error);

    expect(text).toContain('cause1="timeout waiting for socket"');
  });
});
