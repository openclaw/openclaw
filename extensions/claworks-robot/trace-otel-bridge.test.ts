import { describe, expect, it, vi } from "vitest";
import { emitClaworksTraceToOtel } from "./trace-otel-bridge.js";

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  emitTrustedDiagnosticEvent: vi.fn(),
}));

describe("emitClaworksTraceToOtel", () => {
  it("emits trusted diagnostic with trace context", async () => {
    const { emitTrustedDiagnosticEvent } = await import("openclaw/plugin-sdk/diagnostic-runtime");
    emitClaworksTraceToOtel({
      event_id: "e1",
      event_type: "im.message.received",
      source: "feishu",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      playbook_matches: 1,
    });
    expect(emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "diagnostic.phase.completed",
        name: "claworks.event.im.message.received",
        trace: expect.objectContaining({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
        }),
      }),
    );
  });
});
