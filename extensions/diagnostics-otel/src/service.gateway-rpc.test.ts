// Real SDK ids and aggregations protect RPC parents, phase timing, and signal gating.
import { context, metrics, ROOT_CONTEXT, trace } from "@opentelemetry/api";
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
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  startOtelService,
  startOtelServiceWithHostUsage,
  startOtlpReceiver,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

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

test.each([{ traces: false, metricsEnabled: true }])(
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
    emit({
      ...base,
      phase: "response",
      outcome: "ok",
      durationMs: 750,
      responseBytes: 8192,
      firstResponse: false,
    });
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

test("exports the producing agent identity on run, harness, message, tool-loop, and model-call spans", async () => {
  const { service, ctx } = await startOtelService({ traces: true });
  const agent = { agentId: "ops", sessionId: "session-agent" };
  const model = {
    ...agent,
    runId: "run-agent-1",
    provider: "anthropic",
    model: "claude-opus-4-7",
  };

  emitTrustedDiagnosticEvent({
    type: "run.completed",
    ...model,
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "harness.run.completed",
    ...model,
    harnessId: "claude-cli",
    durationMs: 100,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "message.processed",
    ...agent,
    channel: "webchat",
    durationMs: 5,
    outcome: "completed",
  });
  emitTrustedDiagnosticEvent({
    type: "tool.loop",
    ...agent,
    toolName: "read",
    level: "warning",
    action: "warn",
    detector: "generic_repeat",
    count: 3,
    message: "repeated read calls",
  });
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...model,
    callId: "call-agent-1",
    api: "claude-code",
    transport: "stdio-live",
    observationUnit: "turn",
    durationMs: 80,
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spanAgent = (name: string) =>
    sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === name)
      .map((span) => span.attributes["openclaw.agent"]);
  expect(spanAgent("openclaw.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.harness.run")).toEqual(["ops"]);
  expect(spanAgent("openclaw.message.processed")).toEqual(["ops"]);
  expect(spanAgent("openclaw.tool.loop")).toEqual(["ops"]);
  expect(spanAgent("openclaw.model.call")).toEqual(["ops"]);
});

test("adds plugin attribution only from trusted exporter-private provenance", async () => {
  const started = await startOtelServiceWithHostUsage();
  const { service, ctx } = started;

  started.emitHostPluginUsage(
    {
      type: "model.usage",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 30,
        cacheWrite: 20,
        promptTokens: 150,
        total: 190,
      },
      durationMs: 25,
    },
    "llm-task",
  );
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 2 },
    pluginId: "public-emitter-spoof",
  } as Parameters<typeof emitTrustedDiagnosticEvent>[0] & { pluginId: string });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 3 },
  });
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.usage",
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 5 },
    },
    { hostPluginId: "private-data-spoof" } as Parameters<
      typeof emitTrustedDiagnosticEventWithPrivateData
    >[1] & { hostPluginId: string },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const usageSpans = sdk.exporter
    .getFinishedSpans()
    .filter((span) => span.name === "openclaw.model.usage");
  const modelUsageAttributes = usageSpans[0]?.attributes;
  expect(modelUsageAttributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": "anthropic/claude-sonnet-4.6",
    "gen_ai.usage.input_tokens": 150,
    "gen_ai.usage.output_tokens": 40,
    "gen_ai.usage.cache_read.input_tokens": 30,
    "gen_ai.usage.cache_creation.input_tokens": 20,
  });
  for (const key of [
    "openclaw.sessionKey",
    "openclaw.sessionId",
    "gen_ai.provider.name",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
  ]) {
    expect(modelUsageAttributes).not.toHaveProperty(key);
  }
  expect(JSON.stringify(modelUsageAttributes)).not.toContain("session-key");
  expect(usageSpans).toHaveLength(4);
  expect(usageSpans.map((span) => span.attributes["openclaw.plugin"])).toEqual([
    "llm-task",
    undefined,
    undefined,
    undefined,
  ]);
});

test("retains event-loop and GC durations only as metrics with all preloaded SDK signals enabled", async () => {
  const receiver = await startOtlpReceiver();
  let meterProvider: MeterProvider | undefined;
  try {
    context.disable();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const observedParents: Array<string | undefined> = [];
    meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 60_000,
        }),
      ],
      views: ["openclaw.gateway.event_loop.*", "openclaw.gc.duration_ms"].map((instrumentName) => ({
        instrumentName,
        attributesProcessors: [
          {
            process(attributes, measurementContext) {
              observedParents.push(
                measurementContext ? trace.getSpanContext(measurementContext)?.traceId : undefined,
              );
              return attributes;
            },
          },
        ],
      })),
    });
    metrics.disable();
    expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
    let deliveredSamples = 0;
    await startOtelService({
      endpoint: receiver.endpoint,
      traces: true,
      metrics: true,
      logs: true,
      configure(serviceContext) {
        const bridge = serviceContext.internalDiagnostics!;
        serviceContext.internalDiagnostics = {
          ...bridge,
          onEvent(listener, filter) {
            return bridge.onEvent((event, metadata, privateData) => {
              if (event.type === "gateway.event_loop.sample" || event.type === "diagnostic.gc") {
                deliveredSamples++;
              }
              listener(event, metadata, privateData);
            }, filter);
          },
        };
      },
    });
    await waitForDiagnosticEventsDrained();
    const ambientTraceId = "11111111111111111111111111111111";
    const ambient = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: ambientTraceId,
      spanId: "1111111111111111",
      traceFlags: 1,
    });
    const sampleMetrics = () =>
      Object.fromEntries(
        (
          metricExporter
            .getMetrics()
            .at(-1)
            ?.scopeMetrics.flatMap((scope) => scope.metrics) ?? []
        )
          .filter(
            (metric) =>
              metric.descriptor.name.startsWith("openclaw.gateway.event_loop.") ||
              metric.descriptor.name === "openclaw.gc.duration_ms",
          )
          .map(
            (metric) =>
              [
                metric.descriptor.name,
                {
                  unit: metric.descriptor.unit,
                  points: metric.dataPoints.map(({ attributes, value }) => ({
                    attributes,
                    value,
                  })),
                },
              ] as const,
          ),
      );
    for (const [intervalMs, delayMaxMs, totalMs, count, sum] of [
      [2_000, 1_250, 2_000, 1, 1_250],
      [8_000, 20, 10_000, 2, 1_270],
    ] as const) {
      await context.with(ambient, async () => {
        expect(trace.getSpanContext(context.active())?.traceId).toBe(ambientTraceId);
        emitInternalDiagnosticEventForTest({
          type: "gateway.event_loop.sample",
          intervalMs,
          delayMaxMs,
        });
        emitInternalDiagnosticEventForTest({ type: "diagnostic.gc", durationMs: delayMaxMs });
        await waitForDiagnosticEventsDrained();
      });
      await meterProvider.forceFlush();
      expect(sampleMetrics()).toMatchObject({
        "openclaw.gateway.event_loop.delay_max_ms": {
          unit: "ms",
          points: [{ attributes: {}, value: { count, sum } }],
        },
        "openclaw.gateway.event_loop.observed_ms": {
          unit: "ms",
          points: [{ attributes: {}, value: totalMs }],
        },
        "openclaw.gc.duration_ms": {
          unit: "ms",
          points: [{ attributes: {}, value: { count, sum } }],
        },
      });
    }
    const retained = sampleMetrics();
    emitDiagnosticEvent({
      type: "gateway.event_loop.sample",
      intervalMs: 99_000,
      delayMaxMs: 99_000,
    });
    emitDiagnosticEvent({ type: "diagnostic.gc", durationMs: 99_000 });
    await waitForDiagnosticEventsDrained();
    await meterProvider.forceFlush();
    expect(sampleMetrics()).toEqual(retained);
    expect(
      Object.values(sampleMetrics()).flatMap((metric) =>
        metric.points.map(({ attributes }) => attributes),
      ),
    ).toEqual([{}, {}, {}]);
    expect(deliveredSamples).toBe(6);
    expect(observedParents).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    await stopStartedOtelServices();
    expect(sdk.exporter.getFinishedSpans()).toEqual([]);
    expect(receiver.requests).toEqual([]);
  } finally {
    try {
      await stopStartedOtelServices();
    } finally {
      try {
        await meterProvider?.shutdown();
      } finally {
        await receiver.close();
      }
    }
  }
}, 30_000);

test.each([false, true])(
  "exports completed commentary with content capture %s",
  async (captureContent) => {
    await startOtelService({ traces: true, captureContent });
    const harness = { runId: "run-1", harnessId: "codex", trace: createDiagnosticTraceContext() };
    const run = { runId: harness.runId, trace: createChildDiagnosticTraceContext(harness.trace) };
    const commentary = {
      ...harness,
      type: "agent.commentary" as const,
      itemId: "private-item-id",
      sourceSequence: 7,
      sourceTimestampMs: Date.now(),
      textLength: 100,
      contentCaptured: true,
      contentTruncated: false,
    };
    const content = {
      modelContent: {
        outputMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Checking files. Bearer " + "a".repeat(80) }],
          },
        ],
      },
    };
    emitTrustedDiagnosticEvent({ ...harness, type: "harness.run.started" });
    emitTrustedDiagnosticEvent({ ...run, type: "run.started" });
    emitDiagnosticEvent(commentary);
    emitTrustedDiagnosticEventWithPrivateData(commentary, content);
    // run.completed is synchronous. Do not drain between it and the queued
    // harness completion: commentary must reach the real SDK before span.end.
    emitTrustedDiagnosticEvent({
      ...run,
      type: "run.completed",
      outcome: "completed",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      ...harness,
      type: "harness.run.completed",
      outcome: "completed",
      durationMs: 1,
    });
    await waitForDiagnosticEventsDrained();
    const span = sdk.exporter
      .getFinishedSpans()
      .find((entry) => entry.name === "openclaw.harness.run");
    expect(span?.events).toHaveLength(1);
    expect(span?.events[0]).toMatchObject({
      name: "openclaw.agent.commentary",
      attributes: {
        "openclaw.harness.id": "codex",
        "openclaw.commentary.sequence": 7,
        "openclaw.commentary.text_length": 100,
      },
    });
    const exported = JSON.stringify(span?.events);
    expect(exported.includes("Checking files.")).toBe(captureContent);
    expect(exported).not.toContain("a".repeat(80));
    expect(exported).not.toContain("private-item-id");
    emitTrustedDiagnosticEventWithPrivateData(commentary, content);
    await waitForDiagnosticEventsDrained();
    expect(span?.events).toHaveLength(1);
    expect(sdk.exporter.getFinishedSpans()).toHaveLength(2);
  },
);
