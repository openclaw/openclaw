import { describe, expect, it } from "vitest";
import { formatAcpRuntimeErrorText } from "./error-text.js";
import { AcpRuntimeError, toAcpRuntimeError } from "./errors.js";

describe("formatAcpRuntimeErrorText", () => {
  it("adds actionable next steps for known ACP runtime error codes", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing"),
    );
    expect(text).toBe(
      "ACP error (ACP_BACKEND_MISSING): backend missing\nnext: Run `/acp doctor`, install/enable the backend plugin, then retry.",
    );
  });

  it("returns consistent ACP error envelope for runtime failures", () => {
    const text = formatAcpRuntimeErrorText(new AcpRuntimeError("ACP_TURN_FAILED", "turn failed"));
    expect(text).toBe(
      "ACP error (ACP_TURN_FAILED): turn failed\nnext: Retry, or use `/acp cancel` and send the message again.",
    );
  });

  it("includes JSON-RPC details when formatting normalized ACP runtime errors", () => {
    const sourceError = new Error("Internal error") as Error & {
      code: number;
      data: { details: string };
    };
    sourceError.code = -32603;
    sourceError.data = { details: "unknown config option: timeout" };

    const text = formatAcpRuntimeErrorText(
      toAcpRuntimeError({
        error: sourceError,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    );

    expect(text).toBe(
      "ACP error (ACP_TURN_FAILED): Internal error: unknown config option: timeout\nnext: Retry, or use `/acp cancel` and send the message again.",
    );
  });
});
