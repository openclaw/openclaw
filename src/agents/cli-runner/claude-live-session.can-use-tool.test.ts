import { describe, expect, it } from "vitest";
import { buildClaudeLiveCanUseToolResponse } from "./claude-live-session.js";

describe("buildClaudeLiveCanUseToolResponse", () => {
  it("returns the updatedInput shape for allowed can_use_tool requests", () => {
    const response = buildClaudeLiveCanUseToolResponse({
      requestId: "req-allow-1",
      toolInput: { command: "date" },
      allowed: true,
      denyMessage: "denied",
    });

    expect(response).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-allow-1",
        response: { updatedInput: { command: "date" } },
      },
    });
  });

  it("keeps the deny behavior shape for disallowed can_use_tool requests", () => {
    const response = buildClaudeLiveCanUseToolResponse({
      requestId: "req-deny-1",
      toolInput: { command: "rm -rf /" },
      allowed: false,
      denyMessage: "OpenClaw exec policy denied Claude native tool use.",
    });

    expect(response).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-deny-1",
        response: {
          behavior: "deny",
          decisionClassification: "user_reject",
          message: "OpenClaw exec policy denied Claude native tool use.",
        },
      },
    });
  });
});
