import { setImmediate as nextTurn } from "node:timers/promises";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type DiagnosticEventPayload,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, onTestFinished, test, vi } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  emitRealSdkSignals,
  getReportedExporterHealth,
  type ReportedExporterHealth,
  startOtelService,
  startOtlpReceiver,
  TRACE_ID,
  SPAN_ID,
} from "./service.test-helpers.js";

installRealOtelSdkTestHarness({ owned: true, env: ["OTEL_PROPAGATORS"] });
const PROPAGATED_SPAN_CONTEXT = {
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  traceFlags: 1,
  isRemote: true,
} as const;
const W3C_CARRIER = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` };
function roundtrip(value: string, incoming: Record<string, string>, outgoing = { ...incoming }) {
  return { value, incoming, outgoing };
}

async function propagate(incoming: Record<string, string>, baggage?: string) {
  const extracted = propagation.extract(ROOT_CONTEXT, incoming);
  expect(trace.getSpanContext(extracted)).toEqual(PROPAGATED_SPAN_CONTEXT);
  const outgoing: Record<string, string> = {};
  await context.with(extracted, async () => {
    await nextTurn();
    expect(trace.getSpanContext(context.active())).toEqual(PROPAGATED_SPAN_CONTEXT);
    if (baggage) {
      expect(propagation.getBaggage(extracted)?.getEntry("tenant")?.value).toBe(baggage);
      expect(propagation.getBaggage(context.active())?.getEntry("tenant")?.value).toBe(baggage);
    }
    propagation.inject(context.active(), outgoing);
  });
  return { extracted, outgoing };
}

test.each([false, true])(
  "disables exports while preserving external W3C ownership=%s",
  async (external) => {
    if (external) {
      expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
        true,
      );
      expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
    }
    const receiver = await startOtlpReceiver();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.env.OTEL_SDK_DISABLED = " TrUe ";
    const { service, ctx } = await startOtelService({
      endpoint: receiver.endpoint,
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "both",
    });

    try {
      await emitRealSdkSignals();
      const incoming = { ...W3C_CARRIER, ...(!external ? { baggage: "tenant=example" } : {}) };
      const { extracted, outgoing } = await propagate(incoming, external ? undefined : "example");
      expect(outgoing).toEqual(incoming);
      expect(getReportedExporterHealth(ctx)).toEqual([]);

      if (external) {
        await service.stop?.(ctx);
        expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
        expect((await propagate(incoming)).outgoing).toEqual(incoming);
      } else {
        ctx.config.diagnostics!.enabled = false;
        await service.start(ctx);
        expect(
          context.with(extracted, () => trace.getSpanContext(context.active())),
        ).toBeUndefined();
        expect(propagation.fields()).toEqual([]);
      }
      expect(receiver.requests).toEqual([]);
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
      await service.stop?.(ctx);
      await receiver.close();
    }
  },
  30_000,
);

test.each<{
  value: string;
  incoming?: Record<string, string>;
  outgoing?: Record<string, string>;
  warning?: string;
}>([
  { value: "NoNe" },
  {
    value: "unavailable",
    warning: 'Propagator "unavailable" requested through environment variable is unavailable.',
  },
  roundtrip("B3", { b3: `${TRACE_ID}-${SPAN_ID}-1` }),
  roundtrip("B3MULTI", { "x-b3-traceid": TRACE_ID, "x-b3-spanid": SPAN_ID, "x-b3-sampled": "1" }),
  {
    ...roundtrip(
      "JaEgEr",
      { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:1` },
      {
        "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:01`,
      },
    ),
    warning:
      'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.',
  },
])(
  "configures and roundtrips OTEL_PROPAGATORS=$value",
  async ({ value, incoming, outgoing: expectedOutgoing, warning }) => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_PROPAGATORS = value;
    const { service, ctx } = await startOtelService();

    try {
      if (incoming) {
        const { outgoing } = await propagate(incoming);
        expect(outgoing).toEqual(expectedOutgoing);
        expect(trace.getSpanContext(propagation.extract(ROOT_CONTEXT, outgoing))).toEqual(
          PROPAGATED_SPAN_CONTEXT,
        );
      } else {
        expect(propagation.fields()).toEqual([]);
      }
      if (warning) {
        expect(ctx.logger.warn).toHaveBeenCalledWith(warning);
      } else {
        expect(ctx.logger.warn).not.toHaveBeenCalled();
      }
    } finally {
      await service.stop?.(ctx);
    }
    expect(propagation.fields()).toEqual([]);
  },
);

type ExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

async function waitForExporterStatus(
  events: Array<Pick<ReportedExporterHealth, "status">>,
  status: ReportedExporterHealth["status"],
) {
  await vi.waitFor(
    () => {
      expect(events.some((event) => event.status === status)).toBe(true);
    },
    { timeout: 4_000, interval: 20 },
  );
}

function emitExporterHealthSpan(name: string) {
  // The global trace API cannot reach the owned private provider.
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.completed",
      runId: `run-${name}`,
      callId: `call-${name}`,
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 10,
    },
    {},
  );
}

async function startExporterHealth(
  statusForRequest: (count: number) => number,
  flushIntervalMs?: number,
) {
  const receiver = await startOtlpReceiver(statusForRequest);
  const events: ExporterEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "telemetry.exporter") {
      events.push(event);
    }
  });
  process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "1000";
  const started = await startOtelService({
    endpoint: receiver.endpoint,
    traces: true,
    flushIntervalMs,
  });
  onTestFinished(async () => {
    unsubscribe();
    await started.service.stop?.(started.ctx);
    await receiver.close();
  });
  return { receiver, events, ...started };
}

test.each(["retry-success", "non-retryable"] as const)(
  "reports real OTLP %s",
  async (mode) => {
    const retry = mode === "retry-success";
    const { receiver, events, service, ctx } = await startExporterHealth((count) =>
      retry ? (count === 1 ? 503 : 200) : 400,
    );
    emitExporterHealthSpan(mode);
    await waitForDiagnosticEventsDrained();
    const stopped = Promise.resolve(service.stop?.(ctx));
    await (retry ? stopped : stopped.catch(() => {}));
    await waitForDiagnosticEventsDrained();
    expect(receiver.requests).toHaveLength(retry ? 2 : 1);
    const health = getReportedExporterHealth(ctx);
    expect(
      events.filter((event) => event.status === "failure").map((event) => event.reason),
    ).toEqual(retry ? [] : ["emit_failed"]);
    expect(
      health
        .filter((event) => ["failure", "recovered"].includes(event.status))
        .map((event) => [event.status, event.reason]),
    ).toEqual(retry ? [] : [["failure", "export_failed"]]);
  },
  15_000,
);

test("records recovery after a later real OTLP export succeeds", async () => {
  let failExports = true;
  const { events, ctx } = await startExporterHealth(() => (failExports ? 503 : 200), 1000);
  const health = getReportedExporterHealth(ctx);
  emitExporterHealthSpan("failure-before-recovery");
  await waitForDiagnosticEventsDrained();
  await waitForExporterStatus(health, "failure");
  failExports = false;
  emitExporterHealthSpan("successful-recovery");
  await waitForDiagnosticEventsDrained();
  await waitForExporterStatus(health, "recovered");
  expect(
    health.filter((event) => event.reason === "export_failed").map((event) => event.status),
  ).toEqual(["failure", "recovered"]);
  expect(events.map((event) => event.status)).not.toContain("recovered");
}, 15_000);
