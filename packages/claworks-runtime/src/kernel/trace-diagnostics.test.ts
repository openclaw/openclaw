import { describe, expect, it } from "vitest";
import { listObservationEvents } from "../claworks/observability.js";
import { formatTraceparent, createRootTraceContext } from "./trace-context.js";
import {
  buildTraceDiagnostic,
  CLAWORKS_TRACE_OBSERVATION_TYPE,
  recordEventTraceDiagnostic,
} from "./trace-diagnostics.js";

describe("trace-diagnostics", () => {
  it("builds diagnostic from event traceparent", () => {
    const root = createRootTraceContext();
    const traceparent = formatTraceparent(root)!;
    const event = {
      id: "evt-1",
      type: "im.message.received",
      source: "feishu",
      timestamp: new Date(),
      payload: { text: "hi" },
      traceparent,
      traceId: root.traceId,
    };

    const diag = buildTraceDiagnostic(event, [{ event, playbookId: "p1", priority: 1, input: {} }]);
    expect(diag.trace_id).toBe(root.traceId);
    expect(diag.span_id).toBe(root.spanId);
    expect(diag.playbook_matches).toBe(1);
  });

  it("records observation event for REST / collector correlation", () => {
    const root = createRootTraceContext();
    recordEventTraceDiagnostic({
      id: "evt-2",
      type: "playbook.run.completed",
      source: "playbook-engine",
      timestamp: new Date(),
      payload: {},
      traceparent: formatTraceparent(root),
      traceId: root.traceId,
    });

    const traces = listObservationEvents(20).filter(
      (e) => e.type === CLAWORKS_TRACE_OBSERVATION_TYPE,
    );
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.payload.event_type).toBe("playbook.run.completed");
    expect(traces[0]?.payload.trace_id).toBe(root.traceId);
  });

  it("buildTraceDiagnostic is suitable for OTEL bridge callback", () => {
    const root = createRootTraceContext();
    const traceparent = formatTraceparent(root)!;
    const diag = buildTraceDiagnostic({
      id: "evt-otel",
      type: "im.message.received",
      source: "feishu",
      timestamp: new Date(),
      payload: { text: "hi" },
      traceparent,
      traceId: root.traceId,
    });
    expect(diag.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(diag.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(diag.event_type).toBe("im.message.received");
  });
});
