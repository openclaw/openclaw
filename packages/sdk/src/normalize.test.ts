import { describe, expect, it } from "vitest";
import { normalizeGatewayEvent } from "./normalize.js";

describe("normalizeGatewayEvent", () => {
  it("preserves zero sequence and timestamp values in normalized event ids", () => {
    const event = normalizeGatewayEvent({
      event: "agent",
      seq: 0,
      payload: {
        runId: "r1",
        sessionKey: "main",
        ts: 0,
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });

    expect(event.id).toBe("0:agent:r1:main:0");
    expect(event.ts).toBe(0);
  });
});
