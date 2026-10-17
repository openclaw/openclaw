import { context, metrics, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  type MeterProviderOptions,
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
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, onTestFinished, test } from "vitest";
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

function rpc(
  overrides: Partial<
    Extract<Parameters<typeof emit>[0], { type: "gateway.rpc"; phase: "response" }>
  > = {},
) {
  return {
    type: "gateway.rpc",
    method: "health",
    phase: "response",
    outcome: "ok",
    durationMs: 10,
    ...overrides,
  } as const;
}

function installContext() {
  context.disable();
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
    true,
  );
}

async function collectMetrics(reader: PeriodicExportingMetricReader, prefix = "") {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name.startsWith(prefix));
}

function installMeter(views?: MeterProviderOptions["views"]) {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    ...(views ? { exportIntervalMillis: 60_000 } : {}),
  });
  const meterProvider = new MeterProvider({ readers: [reader], views });
  metrics.disable();
  expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
  if (!views) {
    onTestFinished(async () => {
      try {
        await stopStartedOtelServices();
      } finally {
        await meterProvider.shutdown();
      }
    });
  }
  return { reader, meterProvider, metricExporter };
}

function prefixedAttrs(prefix: string, values: Record<string, string | number>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value]),
  );
}

function metricSnapshot(data: MetricData[], prefix = "openclaw.") {
  return Object.fromEntries(
    data.map(({ descriptor, dataPoints }) => [
      descriptor.name.replace(prefix, ""),
      {
        unit: descriptor.unit,
        points: dataPoints.map(({ attributes, value }) => ({ attributes, value })),
      },
    ]),
  );
}

function countEvents(types: string[]) {
  const counts = Object.fromEntries(types.map((type) => [type, 0]));
  return {
    counts,
    configure(ctx: OpenClawPluginServiceContext) {
      const bridge = ctx.internalDiagnostics!;
      ctx.internalDiagnostics = {
        ...bridge,
        onEvent(listener, filter) {
          return bridge.onEvent((event, metadata, privateData) => {
            if (Object.hasOwn(counts, event.type)) {
              counts[event.type]++;
            }
            listener(event, metadata, privateData);
          }, filter);
        },
      };
    },
  };
}

function metricPoint(attributes: Record<string, string | number>, value: unknown) {
  return expect.objectContaining({ attributes, value });
}

function histogramPoint(attributes: Record<string, string | number>, count: number, sum: number) {
  return metricPoint(attributes, expect.objectContaining({ count, sum }));
}

test("exports untimed response observations on their trusted turn without counting usage twice", async () => {
  const { reader } = installMeter();
  await startOtelService({ traces: true, metrics: true });
  const turn = {
    runId: "response-run",
    callId: "response-turn",
    provider: "openai",
    model: "test-model",
    observationUnit: "turn" as const,
    trace: createDiagnosticTraceContext(),
  };
  emit({ type: "model.call.started", ...turn });
  const response = {
    ...turn,
    type: "model.response.observed" as const,
    timestampSource: "receipt" as const,
    usageSource: "native-normalized" as const,
    usageScope: "response" as const,
    upstreamRequestIdHash: "sha256:0123456789abcdef",
    usage: {
      input: 6,
      output: 4,
      cacheRead: 3,
      cacheWrite: 1,
      reasoningTokens: 2,
      total: 14,
      promptTokens: 10,
    },
  };
  emitDiagnosticEvent(response);
  emit(response);
  emit({
    ...response,
    upstreamRequestIdHash: "sha256:fedcba9876543210",
    usage: { cacheRead: 3 },
  });
  emit({ type: "model.call.completed", ...turn, durationMs: 20 });
  emit({ type: "model.usage", provider: "openai", model: "test-model", usage: response.usage });
  await waitForDiagnosticEventsDrained();
  const span = spanNamed(sdk.exporter.getFinishedSpans(), "openclaw.model.call");
  expect(span?.events).toHaveLength(2);
  expect(span?.events[0]).toMatchObject({
    name: "openclaw.model.response.observed",
    attributes: {
      "openclaw.upstreamRequestIdHash": response.upstreamRequestIdHash,
      "openclaw.model_response.timestamp_source": "receipt",
      "openclaw.model_response.usage_source": "native-normalized",
      "openclaw.model_response.usage_scope": "response",
      "openclaw.model_call.usage.input_tokens": 6,
      "openclaw.model_call.usage.output_tokens": 4,
      "openclaw.model_call.usage.reasoning_output_tokens": 2,
      "gen_ai.usage.input_tokens": 10,
    },
  });
  expect(span?.events[1]?.attributes).not.toHaveProperty("gen_ai.usage.input_tokens");
  expect(
    sdk.exporter
      .getFinishedSpans()
      .map((item) => item.name)
      .toSorted(),
  ).toEqual(["openclaw.model.call", "openclaw.model.usage"]);
  const { resourceMetrics } = await reader.collect();
  const tokenMetrics = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === "openclaw.tokens");
  expect(
    tokenMetrics?.dataPoints.find((point) => point.attributes["openclaw.token"] === "total")?.value,
  ).toBe(14);
  emit(response);
  await waitForDiagnosticEventsDrained();
  expect(span?.events).toHaveLength(2);
});

test("keeps runtime phase parents explicit when observations arrive under another trace", async () => {
  installContext();
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
    const phaseSpan = (name: string) =>
      spans.find((span) => span.attributes["openclaw.phase"] === name)!;
    const provider = phaseSpan("sessions.catalog.list.provider");
    const planning = phaseSpan("sessions.catalog.list.planning");
    const delivery = phaseSpan("sessions.catalog.list.delivery");
    const startup = phaseSpan("startup.fixture");
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
  { traces: false, metricsEnabled: true },
  { traces: true, metricsEnabled: false },
])(
  "honors preloaded signal toggles (traces=$traces metrics=$metricsEnabled)",
  async ({ traces, metricsEnabled }) => {
    const { reader } = installMeter();
    const { counts, configure } = countEvents([
      "diagnostic.phase.completed",
      "gateway.ws.event",
      "gateway.ws.connections",
      "sessions.list.retention",
    ]);
    await startOtelService({ traces, metrics: metricsEnabled, configure });
    emit(rpc());
    emit({ type: "gateway.ws.event", event: "chat", count: 1, bytes: 128 });
    emit({ type: "gateway.ws.connections", operators: 1 });
    emit({ type: "sessions.list.retention", views: 3, refs: 17, estimatedBytes: 3_504 });
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

    expect({
      phases: counts["diagnostic.phase.completed"],
      sockets: counts["gateway.ws.event"] + counts["gateway.ws.connections"],
      retention: counts["sessions.list.retention"],
    }).toEqual({
      phases: traces ? 1 : 0,
      sockets: metricsEnabled ? 2 : 0,
      retention: metricsEnabled ? 1 : 0,
    });
    for (const name of [
      "openclaw.gateway.rpc.response",
      "openclaw.model.usage",
      "openclaw.diagnostic.phase",
    ]) {
      expect(Boolean(spanNamed(sdk.exporter.getFinishedSpans(), name))).toBe(traces);
    }
    const names = (await collectMetrics(reader)).map((metric) => metric.descriptor.name);
    expect(names).toEqual(
      metricsEnabled
        ? expect.arrayContaining(["openclaw.gateway.rpc.first_response_ms", "openclaw.tokens"])
        : [],
    );
  },
);

test("keeps parentless Gateway RPC spans out of unrelated ambient OpenTelemetry traces", async () => {
  installContext();
  const unrelated = sdk.provider.getTracer("unrelated").startSpan("unrelated.request");
  try {
    await startOtelService({ traces: true });
    await waitForDiagnosticEventsDrained();
    const diagnosticRoot = createDiagnosticTraceContext();
    await context.with(trace.setSpan(context.active(), unrelated), async () => {
      emit(rpc());
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
  const { reader } = installMeter();
  await startOtelService({ traces: true, metrics: true });
  const upstream = sdk.provider.getTracer("rpc-peer").startSpan("peer.request");
  const upstreamContext = upstream.spanContext();
  const parent = createDiagnosticTraceContext({
    traceId: upstreamContext.traceId,
    spanId: upstreamContext.spanId,
    traceFlags: "01",
  });
  const rpcTrace = createChildDiagnosticTraceContext(parent);
  const base = { type: "gateway.rpc" as const, method: "sessions.list", trace: rpcTrace };
  const observe = (event: Parameters<typeof rpc>[0]) =>
    emit(rpc({ method: "sessions.list", trace: rpcTrace, ...event }));
  try {
    emit({ ...base, phase: "received" });
    observe({ durationMs: 250 });
    observe({ durationMs: 750, responseBytes: 8192, firstResponse: false });
    emit({ ...base, phase: "handler", outcome: "returned", durationMs: 400, admissionMs: 100 });
    emit({
      ...base,
      phase: "dispatch",
      outcome: "returned",
      durationMs: 500,
      queueWaitMs: 75,
      response: "sent",
    });
    observe({ method: "health" });
    observe({ method: "health", outcome: "error", durationMs: 20 });
    emit({ ...base, method: "unknown", phase: "received" });
    observe({ method: "unknown", outcome: "unavailable", durationMs: 20 });
    observe({ method: "unknown", outcome: "suppressed", durationMs: 30 });
    emit({
      ...base,
      method: "unknown",
      phase: "dispatch",
      outcome: "rejected",
      durationMs: 30,
      response: "suppressed",
    });
    emitDiagnosticEvent(rpc({ method: "unknown", trace: rpcTrace, durationMs: 50 }));
    await waitForDiagnosticEventsDrained();

    const rpcMetrics = await collectMetrics(reader, "openclaw.gateway.rpc.");
    const pointsFor = (name: string) =>
      rpcMetrics.find((metric) => metric.descriptor.name === `openclaw.gateway.rpc.${name}`)
        ?.dataPoints;
    const methodAttrs = { "openclaw.gateway.rpc.method": "sessions.list" };
    expect(pointsFor("requests")).toEqual(
      expect.arrayContaining([
        metricPoint(methodAttrs, 1),
        metricPoint({ "openclaw.gateway.rpc.method": "unknown" }, 1),
      ]),
    );
    for (const [metric, sum] of [
      ["first_response", 250],
      ["handler", 400],
      ["admission", 100],
      ["queue_wait", 75],
    ]) {
      const points = pointsFor(`${metric}_ms`);
      expect(points).toEqual(expect.arrayContaining([histogramPoint(methodAttrs, 1, sum)]));
      expect(
        points?.some((point) => point.attributes["openclaw.gateway.rpc.method"] === "unknown"),
      ).toBe(false);
    }
    const outcomes = pointsFor("outcomes");
    expect(pointsFor("first_response_ms")).toEqual(
      expect.arrayContaining([histogramPoint({ "openclaw.gateway.rpc.method": "health" }, 2, 30)]),
    );
    const outcomePoint = (phase: string, outcome: string, value: number) =>
      metricPoint(prefixedAttrs("openclaw.gateway.rpc", { phase, outcome }), value);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        outcomePoint("response", "ok", 2),
        outcomePoint("dispatch", "rejected", 1),
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
  for (const name of ["run", "harness.run", "message.processed", "tool.loop", "model.call"]) {
    expect(spanAgent(`openclaw.${name}`)).toEqual(["ops"]);
  }
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
  const publicUsage = { type: "model.usage", provider: "openai", model: "gpt-5.5" } as const;
  emitTrustedDiagnosticEvent({
    ...publicUsage,
    usage: { input: 2 },
    pluginId: "public-emitter-spoof",
  } as Parameters<typeof emitTrustedDiagnosticEvent>[0] & { pluginId: string });
  emitTrustedDiagnosticEvent({ ...publicUsage, usage: { input: 3 } });
  emitTrustedDiagnosticEventWithPrivateData({ ...publicUsage, usage: { input: 5 } }, {
    hostPluginId: "private-data-spoof",
  } as Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[1] & { hostPluginId: string });
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
    const observedParents: Array<string | undefined> = [];
    const installed = installMeter(
      ["openclaw.gateway.event_loop.*", "openclaw.gc.duration_ms"].map((instrumentName) => ({
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
    );
    meterProvider = installed.meterProvider;
    const { metricExporter } = installed;
    const { counts, configure } = countEvents(["gateway.event_loop.sample", "diagnostic.gc"]);
    await startOtelService({
      endpoint: receiver.endpoint,
      traces: true,
      metrics: true,
      logs: true,
      configure,
    });
    await waitForDiagnosticEventsDrained();
    const ambientTraceId = "11111111111111111111111111111111";
    const ambient = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: ambientTraceId,
      spanId: "1111111111111111",
      traceFlags: 1,
    });
    const sampleMetrics = () => {
      const data =
        metricExporter
          .getMetrics()
          .at(-1)
          ?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
      return metricSnapshot(
        data.filter(
          ({ descriptor: { name } }) =>
            name.startsWith("openclaw.gateway.event_loop.") || name === "openclaw.gc.duration_ms",
        ),
      );
    };
    const samplePoint = (value: number | { count: number; sum: number }, attributes = {}) => ({
      unit: "ms",
      points: [
        { attributes, value: typeof value === "number" ? value : expect.objectContaining(value) },
      ],
    });
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
        emitInternalDiagnosticEventForTest({
          type: "diagnostic.gc",
          kind: "scavenge",
          thread: "main",
          durationMs: delayMaxMs,
        });
        await waitForDiagnosticEventsDrained();
      });
      await meterProvider.forceFlush();
      expect(sampleMetrics()).toEqual({
        "gateway.event_loop.delay_max_ms": samplePoint({ count, sum }),
        "gateway.event_loop.observed_ms": samplePoint(totalMs),
        "gc.duration_ms": samplePoint(
          { count, sum },
          prefixedAttrs("openclaw.gc", { kind: "scavenge", thread: "main" }),
        ),
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
    emitInternalDiagnosticEventForTest({
      type: "diagnostic.gc",
      kind: "mark_sweep_compact",
      thread: "code-mode-node.worker.js",
      workerSlot: 2,
      durationMs: 8,
    });
    await waitForDiagnosticEventsDrained();
    await meterProvider.forceFlush();
    expect(sampleMetrics()["gc.duration_ms"]?.points).toContainEqual(
      histogramPoint(
        prefixedAttrs("openclaw.gc", {
          kind: "mark_sweep_compact",
          thread: "code-mode-node.worker.js",
          worker_slot: 2,
        }),
        1,
        8,
      ),
    );
    expect(counts["gateway.event_loop.sample"] + counts["diagnostic.gc"]).toBe(7);
    expect(observedParents).toEqual(Array.from({ length: 7 }, () => undefined));
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
