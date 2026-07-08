import { describe, expect, it } from "vitest";
import { normalizeGatewayEvent } from "./normalize.js";
import type { GatewayEvent } from "./types.js";

// Terminal tool/item events are emitted with phase:"end" plus the real status
// (running|completed|failed|blocked), so failed/blocked must not collapse to completed.
function agentItemEvent(data: Record<string, unknown>) {
  return { event: "agent", payload: { runId: "r1", stream: "item", data } };
}

describe("normalizeGatewayEvent terminal tool item status", () => {
  it("classifies a failed terminal tool item as tool.call.failed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "failed" })).type).toBe(
      "tool.call.failed",
    );
  });

  it("classifies a blocked terminal tool item as tool.call.failed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "blocked" })).type).toBe(
      "tool.call.failed",
    );
  });

  it("still classifies a completed terminal tool item as tool.call.completed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end", status: "completed" })).type).toBe(
      "tool.call.completed",
    );
  });

  it("still classifies a phase:end tool item without status as tool.call.completed", () => {
    expect(normalizeGatewayEvent(agentItemEvent({ phase: "end" })).type).toBe(
      "tool.call.completed",
    );
  });
});

describe("normalizeGatewayEvent ID construction", () => {
  it("preserves seq:0 in the normalized event ID", () => {
    const event: GatewayEvent = {
      event: "agent",
      seq: 0,
      payload: { runId: "r1", sessionKey: "main", ts: 0, stream: "lifecycle", data: {} },
    };
    const result = normalizeGatewayEvent(event);
    expect(result.id).toContain(":0");
  });

  it("preserves ts:0 in the normalized event ID", () => {
    const event: GatewayEvent = {
      event: "agent",
      seq: 1,
      payload: { runId: "r1", sessionKey: "main", ts: 0, stream: "lifecycle", data: {} },
    };
    const result = normalizeGatewayEvent(event);
    const parts = result.id.split(":");
    const lastPart = parts[parts.length - 1];
    expect(lastPart).toBe("0");
  });
});
