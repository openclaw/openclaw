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

  it("redacts provider authentication failure bodies from turn failures", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError(
        "ACP_TURN_FAILED",
        'Internal error: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_abc"}',
      ),
    );
    expect(text).toContain("ACP provider authentication failed");
    expect(text).toContain('agentId="codex"');
    expect(text).not.toContain("req_abc");
    expect(text).not.toContain("authentication_error");
    expect(text).not.toContain("Invalid authentication credentials");
  });
});
