import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type DiagnosticEventPayload,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test, vi } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  emitRealSdkSignals,
  getReportedExporterHealth,
  type ReportedExporterHealth,
  type StartedService,
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

test("disables every OpenClaw route while preserving W3C propagation", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const stdoutWrites: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  process.env.OTEL_SDK_DISABLED = " TrUe ";
  const { service, ctx } = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "both",
  });

  try {
    await emitRealSdkSignals();
    const incoming = { baggage: "tenant=example", ...W3C_CARRIER };
    const { extracted, outgoing } = await propagate(incoming, "example");
    expect(outgoing).toEqual(incoming);
    expect(getReportedExporterHealth(ctx)).toEqual([]);

    ctx.config.diagnostics!.enabled = false;
    await service.start(ctx);
    expect(context.with(extracted, () => trace.getSpanContext(context.active()))).toBeUndefined();
    expect(propagation.fields()).toEqual([]);
    expect(receiver.capturedRequests).toEqual([]);
  } finally {
    stdoutWrite.mockRestore();
    await service.stop?.(ctx);
    await receiver.close();
  }
  expect(stdoutWrites).toEqual([]);
}, 30_000);

test("preserves externally owned context and propagation globals while disabled", async () => {
  const externalContextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
  process.env.OTEL_SDK_DISABLED = "true";
  const { service, ctx } = await startOtelService();
  const extracted = propagation.extract(ROOT_CONTEXT, W3C_CARRIER);

  await service.stop?.(ctx);

  expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
  await context.with(extracted, async () => {
    await nextTurn();
    expect(trace.getSpanContext(context.active())?.traceId).toBe(TRACE_ID);
  });
});

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
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.status === status)) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for exporter status ${status}`);
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
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    {},
  );
}

async function withExporterHealth(
  statusForRequest: (count: number) => number,
  run: (
    fixture: StartedService & {
      receiver: Awaited<ReturnType<typeof startOtlpReceiver>>;
      events: ExporterEvent[];
    },
  ) => Promise<void>,
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
  try {
    await run({ receiver, events, ...started });
  } finally {
    unsubscribe();
    await started.service.stop?.(started.ctx);
    await receiver.close();
  }
}

test.each(["retry-success", "non-retryable"] as const)(
  "reports real OTLP %s",
  async (mode) => {
    const retry = mode === "retry-success";
    await withExporterHealth(
      (count) => (retry ? (count === 1 ? 503 : 200) : 400),
      async ({ receiver, events, service, ctx }) => {
        emitExporterHealthSpan(mode);
        await waitForDiagnosticEventsDrained();
        const stopped = Promise.resolve(service.stop?.(ctx));
        await (retry ? stopped : stopped.catch(() => {}));
        await waitForDiagnosticEventsDrained();
        expect(receiver.requests).toHaveLength(retry ? 2 : 1);
        const health = getReportedExporterHealth(ctx);
        if (retry) {
          expect(events.some((event) => event.status === "failure")).toBe(false);
          expect(health.some((event) => ["failure", "recovered"].includes(event.status))).toBe(
            false,
          );
        } else {
          expect(
            events.filter((event) => event.status === "failure" && event.reason === "emit_failed"),
          ).toHaveLength(1);
          expect(
            health.filter(
              (event) => event.status === "failure" && event.reason === "export_failed",
            ),
          ).toHaveLength(1);
        }
      },
    );
  },
  15_000,
);

test("records recovery after a later real OTLP export succeeds", async () => {
  let failExports = true;
  await withExporterHealth(
    () => (failExports ? 503 : 200),
    async ({ events, ctx }) => {
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
    },
    1000,
  );
}, 15_000);
