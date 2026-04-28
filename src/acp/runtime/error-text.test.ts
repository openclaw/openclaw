import { describe, expect, it } from "vitest";
import { formatAcpRuntimeErrorText } from "./error-text.js";
import { AcpRuntimeError } from "./errors.js";

describe("formatAcpRuntimeErrorText", () => {
  it("adds actionable next steps for known ACP runtime error codes", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing"),
    );
    expect(text).toContain("ACP error (ACP_BACKEND_MISSING): backend missing");
    expect(text).toContain("next:");
  });

  it("returns consistent ACP error envelope for runtime failures", () => {
    const text = formatAcpRuntimeErrorText(new AcpRuntimeError("ACP_TURN_FAILED", "turn failed"));
    expect(text).toContain("ACP error (ACP_TURN_FAILED): turn failed");
    expect(text).toContain("next:");
  });

  it("surfaces JSON-RPC data.details from the underlying cause", () => {
    const cause = {
      code: -32603,
      message: "Internal error",
      data: { details: "Unknown config option: timeout" },
    };
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", { cause }),
    );
    expect(text).toContain("ACP error (ACP_TURN_FAILED): Internal error");
    expect(text).toContain("detail: Unknown config option: timeout");
    expect(text).toContain("next:");
  });

  it("omits the detail line when the underlying cause carries no JSON-RPC payload", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_TURN_FAILED", "ECONNRESET", { cause: new Error("ECONNRESET") }),
    );
    expect(text).not.toContain("detail:");
  });
});
