// Real SDK ids and aggregations protect RPC parents, phase timing, and signal gating.
import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});
function spanNamed(spans: ReadableSpan[], name: string) {
  return spans.find((span) => span.name === name);
}

test("keeps runtime phase parents explicit when observations arrive under another trace", async () => {
  context.disable();
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
    true,
  );
  await startOtelService({ traces: true });
  await waitForDiagnosticEventsDrained();
  const tracer = sdk.provider.getTracer("phase-caller");
  const caller = tracer.startSpan("catalog.caller");
  const unrelated = tracer.startSpan("unrelated.drain");
  const parent = createDiagnosticTraceContext({
    traceId: caller.spanContext().traceId,
    spanId: caller.spanContext().spanId,
  });
  const requestTrace = createChildDiagnosticTraceContext(parent);
  const parentlessRequestTrace = createDiagnosticTraceContext();
  const phase = {
    type: "diagnostic.phase.completed" as const,
    startedAt: Date.now() - 25,
    durationMs: 25,
  };
  try {
    await context.with(trace.setSpan(context.active(), unrelated), async () => {
      await Promise.resolve();
      emit({ ...phase, name: "sessions.catalog.list.provider", trace: requestTrace });
      emit({
        ...phase,
        name: "sessions.catalog.list.planning",
        details: { threadCpuMs: 1.25 },
      });
      emit({
        ...phase,
        name: "sessions.catalog.list.delivery",
        trace: parentlessRequestTrace,
      });
      emitDiagnosticEvent({ ...phase, name: "startup.fixture", cpuTotalMs: 10 });
      await waitForDiagnosticEventsDrained();
    });
    const spans = sdk.exporter.getFinishedSpans();
    const provider = spans.find(
      (span) => span.attributes["openclaw.phase"] === "sessions.catalog.list.provider",
    )!;
    const planning = spans.find(
      (span) => span.attributes["openclaw.phase"] === "sessions.catalog.list.planning",
    )!;
    const delivery = spans.find(
      (span) => span.attributes["openclaw.phase"] === "sessions.catalog.list.delivery",
    )!;
    const startup = spans.find((span) => span.attributes["openclaw.phase"] === "startup.fixture")!;
    expect(provider.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(provider.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(planning.parentSpanContext).toBeUndefined();
    expect(planning.spanContext().traceId).not.toBe(unrelated.spanContext().traceId);
    expect(planning.attributes["openclaw.phase.detail.threadCpuMs"]).toBe(1.25);
    expect(planning.attributes).not.toHaveProperty("openclaw.phase.cpu_total_ms");
    expect(delivery.parentSpanContext).toBeUndefined();
    expect(delivery.spanContext().traceId).not.toBe(parentlessRequestTrace.traceId);
    expect(delivery.spanContext().traceId).not.toBe(unrelated.spanContext().traceId);
    expect(startup.parentSpanContext?.spanId).toBe(unrelated.spanContext().spanId);
    expect(startup.attributes["openclaw.phase.cpu_total_ms"]).toBe(10);
  } finally {
    caller.end();
    unrelated.end();
  }
});

test.each([
  { traces: true, metricsEnabled: false },
  { traces: false, metricsEnabled: true },
  { traces: true, metricsEnabled: true },
])(
  "honors preloaded signal toggles (traces=$traces metrics=$metricsEnabled)",
  async ({ traces, metricsEnabled }) => {
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    try {
      metrics.disable();
      expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
      let deliveredPhases = 0;
      await startOtelService({
        traces,
        metrics: metricsEnabled,
        configure(serviceContext) {
          const bridge = serviceContext.internalDiagnostics!;
          serviceContext.internalDiagnostics = {
            ...bridge,
            onEvent(listener, filter) {
              return bridge.onEvent((event, metadata, privateData) => {
                if (event.type === "diagnostic.phase.completed") {
                  deliveredPhases++;
                }
                listener(event, metadata, privateData);
              }, filter);
            },
          };
        },
      });
      emit({
        type: "gateway.rpc",
        method: "health",
        phase: "response",
        outcome: "ok",
        durationMs: 10,
      });
      emit({
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 5, output: 3, total: 8 },
      });
      emit({
        type: "diagnostic.phase.completed",
        name: "sessions.catalog.list.provider",
        startedAt: Date.now() - 10,
        durationMs: 10,
      });
      await waitForDiagnosticEventsDrained();

      expect(deliveredPhases).toBe(traces ? 1 : 0);
      for (const name of [
        "openclaw.gateway.rpc.response",
        "openclaw.model.usage",
        "openclaw.diagnostic.phase",
      ]) {
        expect(Boolean(spanNamed(sdk.exporter.getFinishedSpans(), name))).toBe(traces);
      }
      const { resourceMetrics, errors } = await reader.collect();
      expect(errors).toEqual([]);
      const names = resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => metric.descriptor.name),
      );
      if (metricsEnabled) {
        expect(names).toEqual(
          expect.arrayContaining(["openclaw.gateway.rpc.first_response_ms", "openclaw.tokens"]),
        );
      } else {
        expect(names).toEqual([]);
      }
    } finally {
      try {
        await stopStartedOtelServices();
      } finally {
        await meterProvider.shutdown();
      }
    }
  },
);

test("keeps parentless Gateway RPC spans out of unrelated ambient OpenTelemetry traces", async () => {
  context.disable();
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
    true,
  );
  const unrelated = sdk.provider.getTracer("unrelated").startSpan("unrelated.request");
  try {
    await startOtelService({ traces: true });
    await waitForDiagnosticEventsDrained();
    const diagnosticRoot = createDiagnosticTraceContext();
    await context.with(trace.setSpan(context.active(), unrelated), async () => {
      emit({
        type: "gateway.rpc",
        method: "health",
        phase: "response",
        outcome: "ok",
        durationMs: 10,
      });
      emit({
        type: "gateway.rpc",
        method: "health",
        phase: "handler",
        outcome: "returned",
        durationMs: 20,
        admissionMs: 5,
        trace: diagnosticRoot,
      });
      emit({
        type: "gateway.rpc",
        method: "health",
        phase: "dispatch",
        outcome: "returned",
        durationMs: 25,
        response: "sent",
        trace: diagnosticRoot,
      });
      await waitForDiagnosticEventsDrained();
    });

    const spans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith("openclaw.gateway.rpc."));
    expect(spans.map((span) => span.name).toSorted()).toEqual([
      "openclaw.gateway.rpc.dispatch",
      "openclaw.gateway.rpc.handler",
      "openclaw.gateway.rpc.response",
    ]);
    for (const span of spans) {
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.spanContext().traceId).not.toBe(unrelated.spanContext().traceId);
    }
  } finally {
    unrelated.end();
  }
});

test("exports Gateway RPC phase metrics with real SDK aggregation and upstream trace parents", async () => {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  const { service, ctx } = await startOtelService({ traces: true, metrics: true });
  const upstream = sdk.provider.getTracer("rpc-peer").startSpan("peer.request");
  const upstreamContext = upstream.spanContext();
  const parent = createDiagnosticTraceContext({
    traceId: upstreamContext.traceId,
    spanId: upstreamContext.spanId,
    traceFlags: "01",
  });
  const base = {
    type: "gateway.rpc" as const,
    method: "sessions.list",
    trace: createChildDiagnosticTraceContext(parent),
  };
  try {
    emit({ ...base, phase: "received" });
    emit({ ...base, phase: "response", outcome: "ok", durationMs: 250 });
    emit({ ...base, phase: "handler", outcome: "returned", durationMs: 400, admissionMs: 100 });
    emit({
      ...base,
      phase: "dispatch",
      outcome: "returned",
      durationMs: 500,
      queueWaitMs: 75,
      response: "sent",
    });
    emit({ ...base, method: "health", phase: "response", outcome: "ok", durationMs: 10 });
    emit({ ...base, method: "health", phase: "response", outcome: "error", durationMs: 20 });
    const rejected = { ...base, method: "unknown" };
    emit({ ...rejected, phase: "received" });
    emit({ ...rejected, phase: "response", outcome: "unavailable", durationMs: 20 });
    emit({ ...rejected, phase: "response", outcome: "suppressed", durationMs: 30 });
    emit({
      ...rejected,
      phase: "dispatch",
      outcome: "rejected",
      durationMs: 30,
      response: "suppressed",
    });
    emitDiagnosticEvent({ ...rejected, phase: "response", outcome: "ok", durationMs: 50 });
    await waitForDiagnosticEventsDrained();

    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const rpcMetrics = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name.startsWith("openclaw.gateway.rpc."));
    const methodAttrs = { "openclaw.gateway.rpc.method": "sessions.list" };
    expect(
      rpcMetrics.find((metric) => metric.descriptor.name.endsWith(".requests"))?.dataPoints,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: methodAttrs, value: 1 }),
        expect.objectContaining({
          attributes: { "openclaw.gateway.rpc.method": "unknown" },
          value: 1,
        }),
      ]),
    );
    for (const [metric, sum] of [
      ["first_response", 250],
      ["handler", 400],
      ["admission", 100],
      ["queue_wait", 75],
    ]) {
      const points = rpcMetrics.find(
        (entry) => entry.descriptor.name === `openclaw.gateway.rpc.${metric}_ms`,
      )?.dataPoints;
      expect(points).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: methodAttrs,
            value: expect.objectContaining({ count: 1, sum }),
          }),
        ]),
      );
      expect(
        points?.some((point) => point.attributes["openclaw.gateway.rpc.method"] === "unknown"),
      ).toBe(false);
    }
    const outcomes = rpcMetrics.find((metric) =>
      metric.descriptor.name.endsWith(".outcomes"),
    )?.dataPoints;
    expect(
      rpcMetrics.find((metric) => metric.descriptor.name.endsWith(".first_response_ms"))
        ?.dataPoints,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: { "openclaw.gateway.rpc.method": "health" },
          value: expect.objectContaining({ count: 2, sum: 30 }),
        }),
      ]),
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: {
            "openclaw.gateway.rpc.phase": "response",
            "openclaw.gateway.rpc.outcome": "ok",
          },
          value: 2,
        }),
        expect.objectContaining({
          attributes: {
            "openclaw.gateway.rpc.phase": "dispatch",
            "openclaw.gateway.rpc.outcome": "rejected",
          },
          value: 1,
        }),
      ]),
    );
    expect(outcomes?.every((point) => !("openclaw.gateway.rpc.method" in point.attributes))).toBe(
      true,
    );
    expect(
      JSON.stringify(
        rpcMetrics.map((metric) => metric.dataPoints.map((point) => point.attributes)),
      ),
    ).not.toContain(parent.traceId);
    const rpcSpans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["openclaw.gateway.rpc.method"] === "sessions.list");
    expect(rpcSpans.map((span) => span.name).toSorted()).toEqual([
      "openclaw.gateway.rpc.dispatch",
      "openclaw.gateway.rpc.handler",
      "openclaw.gateway.rpc.response",
    ]);
    expect(
      rpcSpans.every(
        (span) =>
          span.parentSpanContext?.spanId === upstreamContext.spanId &&
          span.spanContext().traceId === upstreamContext.traceId,
      ),
    ).toBe(true);
  } finally {
    upstream.end();
    await service.stop?.(ctx);
    await meterProvider.shutdown();
  }
});

test("logs-only exporters do not subscribe to Gateway RPC timings", async () => {
  const received: string[] = [];
  const { service, ctx } = await startOtelService({
    logs: true,
    logsExporter: "stdout",
    configure(serviceContext) {
      const subscribe = serviceContext.internalDiagnostics!.onEvent;
      serviceContext.internalDiagnostics!.onEvent = (listener, filter) =>
        subscribe((...args) => {
          received.push(args[0].type);
          listener(...args);
        }, filter);
    },
  });
  emitTrustedDiagnosticEventWithPrivateData({
    type: "gateway.rpc",
    method: "health",
    phase: "received",
  });
  emitTrustedDiagnosticEventWithPrivateData({
    type: "queue.lane.enqueue",
    lane: "main",
    queueSize: 1,
  });
  emitTrustedDiagnosticEventWithPrivateData({
    type: "log.record",
    level: "INFO",
    message: "synthetic RPC gating proof",
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);
  expect(received).toContain("log.record");
  expect(received).not.toContain("gateway.rpc");
  expect(received).not.toContain("queue.lane.enqueue");
});
