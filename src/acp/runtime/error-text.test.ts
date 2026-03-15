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

  it("routes backend-unavailable failures to ACP doctor guidance", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "acpx exited with code 1"),
    );
    expect(text).toContain("ACP error (ACP_BACKEND_UNAVAILABLE): acpx exited with code 1");
    expect(text).toContain("/acp doctor");
    expect(text).not.toContain("/acp cancel");
  });
});
