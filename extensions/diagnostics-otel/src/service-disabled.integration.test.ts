import { createServer, type ServerResponse } from "node:http";
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
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  emitRealSdkSignals,
  getReportedExporterHealth,
  type ReportedExporterHealth,
  startOtelService,
  TRACE_ID,
  SPAN_ID,
} from "./service.test-helpers.js";

installRealOtelSdkTestHarness({ owned: true, env: ["OTEL_PROPAGATORS"] });
const JAEGER_DEPRECATION_WARNING =
  'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.';
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
const PROPAGATION_ROUNDTRIP_CASES = [
  roundtrip("B3", { b3: `${TRACE_ID}-${SPAN_ID}-1` }),
  roundtrip("B3MULTI", { "x-b3-traceid": TRACE_ID, "x-b3-spanid": SPAN_ID, "x-b3-sampled": "1" }),
  roundtrip(
    "JaEgEr",
    { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:1` },
    {
      "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:01`,
    },
  ),
] as const;

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
    const extracted = propagation.extract(ROOT_CONTEXT, incoming);
    expect(trace.getSpanContext(extracted)).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
    });
    expect(propagation.getBaggage(extracted)?.getEntry("tenant")?.value).toBe("example");
    const outgoing: Record<string, string> = {};
    await context.with(extracted, async () => {
      await nextTurn();
      expect(trace.getSpanContext(context.active())).toMatchObject({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
      });
      expect(propagation.getBaggage(context.active())?.getEntry("tenant")?.value).toBe("example");
      propagation.inject(context.active(), outgoing);
    });
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

test.each([
  { value: "NoNe", fields: [] },
  {
    value: "unavailable",
    fields: [],
    warning: 'Propagator "unavailable" requested through environment variable is unavailable.',
  },
] as const)(
  "configures OTEL_PROPAGATORS=$value and reports dependency warnings visibly",
  async ({ value, fields, warning }) => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_PROPAGATORS = value;
    const { service, ctx } = await startOtelService();

    try {
      expect(propagation.fields()).toEqual(fields);
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

test.each(PROPAGATION_ROUNDTRIP_CASES)(
  "retains and roundtrips $value propagation across async context",
  async ({ value, incoming, outgoing: expectedOutgoing }) => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_PROPAGATORS = value;
    const { service, ctx } = await startOtelService();

    try {
      const extracted = propagation.extract(ROOT_CONTEXT, incoming);
      expect(trace.getSpanContext(extracted)).toEqual(PROPAGATED_SPAN_CONTEXT);

      const outgoing: Record<string, string> = {};
      await context.with(extracted, async () => {
        await nextTurn();
        expect(trace.getSpanContext(context.active())).toEqual(PROPAGATED_SPAN_CONTEXT);
        propagation.inject(context.active(), outgoing);
      });

      expect(outgoing).toEqual(expectedOutgoing);
      if (value === "JaEgEr") {
        expect(ctx.logger.warn).toHaveBeenCalledWith(JAEGER_DEPRECATION_WARNING);
      } else {
        expect(ctx.logger.warn).not.toHaveBeenCalled();
      }
      expect(trace.getSpanContext(propagation.extract(ROOT_CONTEXT, outgoing))).toEqual(
        PROPAGATED_SPAN_CONTEXT,
      );
    } finally {
      await service.stop?.(ctx);
    }
  },
);

test("cleans disabled ownership before a fresh enabled private-provider generation", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  process.env.OTEL_SDK_DISABLED = "true";
  const options = {
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "otlp" as const,
  };
  const disabled = await startOtelService(options);

  try {
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    await disabled.service.stop?.(disabled.ctx);
    process.env.OTEL_SDK_DISABLED = "false";
    const enabled = await startOtelService(options);
    expect(enabled.service).not.toBe(disabled.service);
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    await emitRealSdkSignals("enabled-generation");
    await enabled.service.stop?.(enabled.ctx);

    expect(new Set(receiver.capturedRequests.map((request) => request.signal))).toEqual(
      new Set(["traces", "metrics", "logs"]),
    );
  } finally {
    await disabled.service.stop?.(disabled.ctx);
    await receiver.close();
  }
}, 30_000);

const IMMEDIATE_RETRY_AFTER = "Thu, 01 Jan 1970 00:00:00 GMT";

type ExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

async function startExporterHealthReceiver(
  handleRequest: (response: ServerResponse, requestCount: number) => void,
) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    handleRequest(response, requestCount);
  });
  const port = await listenOnLoopback(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function captureExporterEvents() {
  const events: ExporterEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "telemetry.exporter") {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

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
  emit({
    type: "model.call.completed",
    runId: `run-${name}`,
    callId: `call-${name}`,
    provider: "openai",
    model: "gpt-5.4",
    durationMs: 10,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
}

async function withExporterHealth(
  handleRequest: Parameters<typeof startExporterHealthReceiver>[0],
  run: (fixture: {
    receiver: Awaited<ReturnType<typeof startExporterHealthReceiver>>;
    events: ExporterEvent[];
    service: Awaited<ReturnType<typeof startOtelService>>["service"];
    ctx: Awaited<ReturnType<typeof startOtelService>>["ctx"];
  }) => Promise<void>,
  flushIntervalMs?: number,
) {
  const receiver = await startExporterHealthReceiver(handleRequest);
  const capture = captureExporterEvents();
  process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "1000";
  const started = await startOtelService({
    endpoint: receiver.endpoint,
    traces: true,
    flushIntervalMs,
  });
  try {
    await run({ receiver, events: capture.events, ...started });
  } finally {
    capture.unsubscribe();
    await started.service.stop?.(started.ctx);
    await receiver.close();
  }
}

test("retries a real OTLP 503 then succeeds without an intermediate failure fact", async () => {
  await withExporterHealth(
    (response, requestCount) => {
      response.writeHead(requestCount === 1 ? 503 : 200, {
        ...(requestCount === 1 ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
        "content-type": "application/x-protobuf",
      });
      response.end();
    },
    async ({ receiver, events, service, ctx }) => {
      emitExporterHealthSpan("retry-then-success");
      await waitForDiagnosticEventsDrained();
      await service.stop?.(ctx);
      await waitForDiagnosticEventsDrained();
      expect(receiver.requestCount).toBe(2);
      expect(events.some((event) => event.status === "failure")).toBe(false);
      expect(
        getReportedExporterHealth(ctx).some(
          (event) => event.status === "failure" || event.status === "recovered",
        ),
      ).toBe(false);
    },
  );
}, 15_000);

test("records one final failure for a non-retryable real OTLP HTTP 400 response", async () => {
  await withExporterHealth(
    (response) => {
      response.writeHead(400);
      response.end();
    },
    async ({ receiver, events, service, ctx }) => {
      emitExporterHealthSpan("http-400");
      await waitForDiagnosticEventsDrained();
      await Promise.resolve(service.stop?.(ctx)).catch(() => {});
      await waitForDiagnosticEventsDrained();
      expect(receiver.requestCount).toBe(1);
      expect(
        events.filter((event) => event.status === "failure" && event.reason === "emit_failed"),
      ).toHaveLength(1);
      expect(
        getReportedExporterHealth(ctx).filter(
          (event) => event.status === "failure" && event.reason === "export_failed",
        ),
      ).toHaveLength(1);
    },
  );
}, 15_000);

test("records recovery after a later real OTLP export succeeds", async () => {
  let failExports = true;
  await withExporterHealth(
    (response) => {
      response.writeHead(failExports ? 503 : 200, {
        "content-type": "application/x-protobuf",
        ...(failExports ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
      });
      response.end();
    },
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
