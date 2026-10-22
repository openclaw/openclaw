import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { context, diag, metrics, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationTemporality, MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  type DiagnosticTraceContext,
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  parseDiagnosticTraceparent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test, vi } from "vitest";
import { runModelCallAndCaptureTraceparent } from "../../../test/e2e/qa-lab/runtime/otel-model-call.test-support.js";
import {
  type CapturedLogRecord,
  type CapturedSpan,
  startLocalOtlpReceiver,
} from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import {
  captureOtelDiagnostics,
  installRealOtelSdkTestHarness,
  PRELOAD_ENV,
} from "./service.real-sdk.test-support.js";
import {
  clearOtelGlobals,
  createOtelContext,
  emitRealSdkSignals,
  registeredOtelGlobals,
  registeredOtelLogs,
  startOtelService,
  startOtlpReceiver,
} from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
const collector = "https://collector.example.com/otlp";

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

const spanNamed = (spans: ReadableSpan[], name: string) => spans.find((span) => span.name === name);

function releasePreloadedOtelGlobals() {
  clearOtelGlobals();
  process.env[PRELOAD_ENV] = "0";
}

async function collectSignals(
  configure: (ctx: ReturnType<typeof createOtelContext>, endpoint: string) => void,
  flags = { traces: true, metrics: true, logs: true },
) {
  const receiver = await startOtlpReceiver();
  releasePreloadedOtelGlobals();
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    ...flags,
    configure: (serviceContext) => configure(serviceContext, receiver.endpoint),
  });
  try {
    await emitRealSdkSignals();
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
  return { requests: receiver.requests, ctx };
}

const completed = { outcome: "completed", durationMs: 80 } as const;
const runBase = { runId: "run-otlp", provider: "openai", model: "gpt-5.6-luna" };

function completeTool(
  parent: Parameters<typeof createChildDiagnosticTraceContext>[0],
  toolName: string,
  durationMs: number,
  started = false,
) {
  const tool = { runId: runBase.runId, toolName, trace: createChildDiagnosticTraceContext(parent) };
  if (started) {
    emit({ type: "tool.execution.started", ...tool });
  }
  emit({ type: "tool.execution.completed", ...tool, durationMs });
}

function startTurn(parent?: Parameters<typeof createChildDiagnosticTraceContext>[0]) {
  const message = {
    channel: parent ? "web" : "telegram",
    trace: parent ? createChildDiagnosticTraceContext(parent) : createDiagnosticTraceContext(),
  };
  const harness = {
    ...runBase,
    harnessId: parent ? "openclaw" : "claude-cli",
    trace: createChildDiagnosticTraceContext(message.trace),
  };
  const run = { ...runBase, trace: createChildDiagnosticTraceContext(harness.trace) };
  emit({ type: "message.dispatch.started", ...message, source: parent ? "http" : "webhook" });
  emit({ type: "harness.run.started", ...harness });
  emit({ type: "run.started", ...run });
  return { message, harness, run };
}

function endTurn({ message, harness, run }: ReturnType<typeof startTurn>) {
  emit({ type: "run.completed", ...run, ...completed, durationMs: 60 });
  emit({ type: "harness.run.completed", ...harness, ...completed, durationMs: 70 });
  emit({ type: "message.processed", ...message, ...completed });
}

test("bounds tool metric series across collections while preserving span parameter lengths", async () => {
  const reader = new (class extends MetricReader {
    protected async onForceFlush() {}
    protected async onShutdown() {}
  })({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  try {
    const { service, ctx } = await startOtelService({ traces: true, metrics: true });
    try {
      for (const iteration of [1, 2]) {
        for (const paramsSummary of [
          { kind: "string", length: iteration * 3 },
          { kind: "array", length: iteration * 5 },
        ] as const) {
          const tool = { toolName: "read", paramsSummary };
          emit({ type: "tool.execution.completed", ...tool, durationMs: 17 });
          emit({
            type: "tool.execution.blocked",
            ...tool,
            deniedReason: "policy",
            reason: "Blocked by synthetic policy",
          });
        }
        await waitForDiagnosticEventsDrained();
        const { resourceMetrics } = await reader.collect();
        if (iteration === 2) {
          const exported = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
          for (const suffix of ["duration_ms", "blocked"]) {
            const points = exported.find(
              (metric) => metric.descriptor.name === `openclaw.tool.execution.${suffix}`,
            )?.dataPoints;
            expect(points).toHaveLength(2);
            expect(
              points?.map((point) => point.attributes["openclaw.tool.params.kind"]).toSorted(),
            ).toEqual(["array", "string"]);
            for (const point of points ?? []) {
              expect(point.attributes).not.toHaveProperty("openclaw.tool.params.length");
              expect(typeof point.value === "number" ? point.value : point.value.count).toBe(2);
            }
          }
        }
      }
      await sdk.provider.forceFlush();
      expect(
        sdk.exporter
          .getFinishedSpans()
          .map((span) => span.attributes["openclaw.tool.params.length"])
          .toSorted((a, b) => Number(a) - Number(b)),
      ).toEqual([3, 3, 5, 5, 6, 6, 10, 10]);
    } finally {
      await service.stop?.(ctx);
    }
  } finally {
    await provider.shutdown();
  }
});

test.each([
  ["config", "/v1/traces/", "traces metrics logs"],
  ["environment", "/?tenant=team/", "traces?tenant=team/ metrics?tenant=team/ logs?tenant=team/"],
  [
    "config",
    "/v1/traces/?tenant=team/",
    "traces/?tenant=team/ metrics?tenant=team/ logs?tenant=team/",
  ],
] as const)(
  "routes real exporters from %s endpoint %s",
  async (source, suffix, expected) => {
    const { requests } = await collectSignals((ctx, endpoint) => {
      const otel = ctx.config.diagnostics!.otel!;
      otel.endpoint = `${endpoint}/api/public/otel${suffix}`;
      if (source === "environment") {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otel.endpoint;
        delete otel.endpoint;
      }
    });
    expect(new Set(requests.map((request) => request.url))).toEqual(
      new Set(expected.split(" ").map((signal) => `/api/public/otel/v1/${signal}`)),
    );
    for (const request of requests) {
      expect(request).toMatchObject({ method: "POST", contentType: "application/x-protobuf" });
    }
  },
  30_000,
);

test("merges exporter headers with config and required protobuf precedence", async () => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS =
    "x-env-only=env-value,x-precedence=env-value,content-type=text/plain";
  const { requests } = await collectSignals((ctx, endpoint) => {
    const otel = ctx.config.diagnostics!.otel!;
    otel.tracesEndpoint = `${endpoint}/custom-traces?tenant=red`;
    otel.metricsEndpoint = `${endpoint}/custom-metrics/`;
    otel.logsEndpoint = `${endpoint}/v1/traces`;
    otel.headers = {
      "content-type": "application/json",
      "x-config-only": "config-value",
      "x-precedence": "config-value",
    };
  });
  expect(new Set(requests.map((request) => request.url))).toEqual(
    new Set(["/custom-traces?tenant=red", "/custom-metrics/", "/v1/traces"]),
  );
  for (const request of requests) {
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        "x-config-only": "config-value",
        "x-env-only": "env-value",
        "x-precedence": "config-value",
      },
    });
  }
}, 30_000);

test("does not auto-enable rejected traces when metrics start the real SDK", async () => {
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "grpc";
  process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/protobuf";
  const { requests, ctx } = await collectSignals(
    (serviceContext) => {
      delete serviceContext.config.diagnostics!.otel!.protocol;
    },
    { traces: true, metrics: true, logs: false },
  );
  expect(new Set(requests.map((request) => request.url))).toEqual(new Set(["/v1/metrics"]));
  expect(ctx.logger.warn).toHaveBeenCalledWith(
    "diagnostics-otel: unsupported traces protocol grpc; OTLP export disabled",
  );
}, 30_000);

test("propagates the exported model span across two OTLP services with one rooted trace", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const endpoint = `http://127.0.0.1:${port}`;
  releasePreloadedOtelGlobals();

  const peerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "openclaw-otel-peer" }),
    spanProcessors: [
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
  });
  const peerTracer = peerProvider.getTracer("openclaw-otel-peer");
  const peerRoot = peerTracer.startSpan("peer.request");
  const peerRootContext = peerRoot.spanContext();
  const inboundParent = createDiagnosticTraceContext({
    traceId: peerRootContext.traceId,
    spanId: peerRootContext.spanId,
    traceFlags: peerRootContext.traceFlags.toString(16).padStart(2, "0"),
  });

  const { service, ctx } = await startOtelService({
    endpoint,
    traces: true,
    metrics: false,
    logs: false,
    configure: (serviceContext) => {
      serviceContext.config.diagnostics!.otel!.serviceName = "openclaw-otel-gateway";
    },
  });

  try {
    const turn = startTurn(inboundParent);
    const outboundTraceparent = await runModelCallAndCaptureTraceparent({
      ...turn.run,
      callId: "call-live-bridge",
    });
    const outboundContext = parseDiagnosticTraceparent(outboundTraceparent);
    expect(outboundContext).toBeDefined();
    const peerCallback = peerTracer.startSpan(
      "peer.callback",
      {},
      trace.setSpanContext(context.active(), {
        traceId: outboundContext!.traceId,
        spanId: outboundContext!.spanId!,
        traceFlags: Number.parseInt(outboundContext!.traceFlags ?? "00", 16),
        isRemote: true,
      }),
    );
    peerCallback.end();

    completeTool(turn.run.trace, "http", 10, true);
    endTurn(turn);
    await waitForDiagnosticEventsDrained();
    peerRoot.end();
    await service.stop?.(ctx);
    await peerProvider.shutdown();

    const names = new Set([
      "peer.request",
      "peer.callback",
      ...["message.processed", "harness.run", "run", "model.call", "tool.execution"].map(
        (name) => `openclaw.${name}`,
      ),
    ]);
    const spans = receiver.capturedSpans.filter((span) => names.has(span.name));
    const spanIds = new Set(spans.map((span) => span.spanId));
    const roots = spans.filter((span) => !span.parentSpanId);
    const modelSpan = spans.find((span) => span.name === "openclaw.model.call");

    expect(spans).toHaveLength(7);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(roots.map((span) => span.name)).toEqual(["peer.request"]);
    expect(spans.every((span) => !span.parentSpanId || spanIds.has(span.parentSpanId))).toBe(true);
    const { traceId, spanId } = modelSpan ?? {};
    expect(outboundContext).toMatchObject({ traceId, spanId });
    expect(spans.find((span) => span.name === "peer.callback")?.parentSpanId).toBe(spanId);
  } finally {
    peerRoot.end();
    await service.stop?.(ctx);
    await peerProvider.shutdown();
    await receiver.close();
  }
}, 30_000);

test("keeps a whole turn on one trace when children arrive after their parent ended", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const { message, harness, run } = startTurn();
  emit({
    type: "model.call.completed",
    ...runBase,
    callId: "call-1",
    durationMs: 1_200,
    trace: createChildDiagnosticTraceContext(run.trace),
  });
  await waitForDiagnosticEventsDrained();

  // End each parent before its straggler: these must not create fresh traces.
  emit({ type: "run.completed", ...run, ...completed, durationMs: 9_000 });
  completeTool(run.trace, "write", 120);
  emit({ type: "harness.run.completed", ...harness, ...completed, durationMs: 9_500 });
  emit({
    type: "context.assembled",
    ...runBase,
    sessionKey: "session-key",
    channel: message.channel,
    trigger: "message",
    messageCount: 3,
    historyTextChars: 100,
    historyImageBlocks: 0,
    maxMessageTextChars: 100,
    systemPromptChars: 50,
    promptChars: 150,
    promptImages: 0,
    trace: createChildDiagnosticTraceContext(harness.trace),
  });
  emit({ type: "message.processed", ...message, ...completed, durationMs: 10_000 });
  emit({
    type: "model.usage",
    ...runBase,
    usage: { input: 10, output: 5, total: 15 },
    durationMs: 30,
    trace: createChildDiagnosticTraceContext(message.trace),
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spans = sdk.exporter.getFinishedSpans();
  const messageSpan = spanNamed(spans, "openclaw.message.processed");
  expect(spans).toHaveLength(7);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(messageSpan?.spanContext().traceId).not.toBe(message.trace.traceId);
  expect(messageSpan?.parentSpanContext).toBeUndefined();
  const id = (name: string) => spanNamed(spans, `openclaw.${name}`)?.spanContext().spanId;
  expect(
    Object.fromEntries(spans.map((span) => [span.name, span.parentSpanContext?.spanId])),
  ).toMatchObject({
    "openclaw.harness.run": id("message.processed"),
    "openclaw.run": id("harness.run"),
    "openclaw.tool.execution": id("run"),
    "openclaw.context.assembled": id("harness.run"),
    "openclaw.model.usage": id("message.processed"),
  });
}, 30_000);

test("keeps a late child on the trace when the turn ended in harness.run.error", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const harnessTrace = createDiagnosticTraceContext();
  const harnessBase = { ...runBase, harnessId: "openclaw", trace: harnessTrace };

  emit({ type: "harness.run.started", ...harnessBase });
  await waitForDiagnosticEventsDrained();

  emit({
    type: "harness.run.error",
    ...harnessBase,
    phase: "send",
    errorCategory: "aborted",
    durationMs: 4_000,
  });
  completeTool(harnessTrace, "bash", 200);
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spans = sdk.exporter.getFinishedSpans();
  const harnessSpan = spanNamed(spans, "openclaw.harness.run");
  const toolSpan = spanNamed(spans, "openclaw.tool.execution");

  expect(harnessSpan).toBeDefined();
  expect(toolSpan).toBeDefined();
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(toolSpan?.parentSpanContext?.spanId).toBe(harnessSpan?.spanContext().spanId);
}, 30_000);

test("leaves exec spans parentless rather than naming a span nobody exported", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  // Tracing enabled mid-turn: no exported ancestor exists.
  const requestScope = createDiagnosticTraceContext();
  const { emitDiagnosticEventWithTrustedTraceContext } =
    await import("openclaw/plugin-sdk/plugin-test-runtime");
  emitDiagnosticEventWithTrustedTraceContext({
    type: "exec.process.completed",
    target: "host",
    mode: "child",
    outcome: "completed",
    durationMs: 640,
    commandLength: 24,
    trace: createChildDiagnosticTraceContext(requestScope),
  } as Parameters<typeof emitDiagnosticEventWithTrustedTraceContext>[0]);
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const execSpan = spanNamed(sdk.exporter.getFinishedSpans(), "openclaw.exec");
  expect(execSpan).toBeDefined();
  expect(execSpan?.parentSpanContext).toBeUndefined();
}, 30_000);

test.each(["signal", "shared"])(
  "rejects malformed collector %s before the real SDK can expose credentials",
  async (source) => {
    process.env[PRELOAD_ENV] = "0";
    const credential = "qa-otel-traces-endpoint-password-sentinel";
    const signal = source === "signal";
    const malformedEndpoint = signal
      ? `\u00a0https://operator:${credential}@collector.example.com/otlp`
      : `https://operator:${credential}@collector.example.com: `;
    process.env[`OTEL_EXPORTER_OTLP_${signal ? "TRACES_" : ""}ENDPOINT`] = malformedEndpoint;
    const ctx = createOtelContext(collector, { traces: true });
    if (signal) {
      ctx.config.diagnostics!.otel!.tracesEndpoint = "https://signal.example.com/otlp";
    }
    await expectSafeStartupFailure(
      ctx,
      credential,
      "Configured OpenTelemetry collector endpoint is invalid; check the collector URL",
    );
  },
);

test.each([
  ["METRICS", { traces: true, metrics: false, logs: false }],
  ["TRACES", { traces: false, metrics: true, logs: false }],
  ["LOGS", { traces: true, metrics: false, logs: true, logsExporter: "stdout" }],
] as const)("does not auto-create an undeclared %s OTLP exporter", async (signal, flags) => {
  process.env[PRELOAD_ENV] = "0";
  const credential = `qa-otel-${signal}-disabled-password`;
  process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] = `https://operator:${credential}@[`;
  const diagnostics = captureOtelDiagnostics();
  const ctx = createOtelContext(collector, flags);
  await withService(ctx, (service) => service.start(ctx));
  expect(diagnostics.join("\n")).not.toContain(credential);
});

const UNREADABLE_TLS_ERROR =
  "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export";

async function expectRejectedTlsStart(message = UNREADABLE_TLS_ERROR, endpoint = collector) {
  process.env[PRELOAD_ENV] = "0";
  const ctx = createOtelContext(endpoint, { traces: true });
  await withService(ctx, (service) => expect(service.start(ctx)).rejects.toThrow(message));
}

async function withService<T>(
  ctx: ReturnType<typeof createOtelContext>,
  run: (service: ReturnType<typeof createDiagnosticsOtelService>) => T | Promise<T>,
) {
  ctx.internalDiagnostics!.emit = () => {};
  const service = createDiagnosticsOtelService();
  try {
    return await run(service);
  } finally {
    await service.stop?.(ctx);
  }
}

async function expectSafeStartupFailure(
  ctx: ReturnType<typeof createOtelContext>,
  sentinel: string,
  message: string,
) {
  const diagnostics = captureOtelDiagnostics();
  const failure = await withService(ctx, (service) =>
    Promise.resolve()
      .then(() => service.start(ctx))
      .catch((error: unknown) => error),
  );
  expect(failure).toBeInstanceOf(Error);
  const startupError = failure as Error;
  expect(startupError.message).toBe(message);
  expect(startupError.stack).not.toContain(sentinel);
  expect(startupError).not.toHaveProperty("cause");
  expect(diagnostics.join("\n")).not.toContain(sentinel);
  for (const logger of [ctx.logger.error, ctx.logger.warn]) {
    expect(JSON.stringify(vi.mocked(logger).mock.calls)).not.toContain(sentinel);
  }
}

test("refuses an unreadable TLS file without exposing its path through the real SDK", async () => {
  process.env[PRELOAD_ENV] = "0";
  const pathSentinel = "qa-otel-traces-certificate-file-sentinel";
  process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = `/definitely-missing/${pathSentinel}.pem`;
  await expectSafeStartupFailure(
    createOtelContext(collector, { traces: true }),
    pathSentinel,
    UNREADABLE_TLS_ERROR,
  );
});

test.each([
  ["/definitely-missing/qa-otel-default-root.pem", ""],
  [` ${process.execPath} `, collector],
])("rejects unreadable TLS path %s with endpoint %s", async (certificate, endpoint) => {
  process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = certificate;
  await expectRejectedTlsStart(UNREADABLE_TLS_ERROR, endpoint);
});

test("rejects the real exporter when only the mTLS client certificate is configured", async () => {
  process.env.OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE = process.execPath;
  await expectRejectedTlsStart(
    "Configured OpenTelemetry mTLS requires both a client certificate and private key; refusing insecure export",
  );
});

test("rejects an empty TLS certificate before the SDK can silently downgrade trust", async () => {
  const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-empty-tls-"));
  const emptyMaterialPath = path.join(certDir, "empty.pem");
  writeFileSync(emptyMaterialPath, "");
  process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = emptyMaterialPath;
  try {
    await expectRejectedTlsStart();
  } finally {
    rmSync(certDir, { force: true, recursive: true });
  }
});

const OWNERSHIP_ENV_KEYS = [
  PRELOAD_ENV,
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_LOG_LEVEL",
] as const;
function releaseOtelGlobals() {
  clearOtelGlobals();
  for (const key of OWNERSHIP_ENV_KEYS) {
    delete process.env[key];
  }
}

function assertCorrelatedGeneration(
  spans: CapturedSpan[],
  logRecords: CapturedLogRecord[],
  logTrace: DiagnosticTraceContext,
): void {
  const run = spans.find((span) => span.name === "openclaw.run");
  const model = spans.find((span) => span.name === "openclaw.model.call");
  const correlatedLog = logRecords.find(
    (record) => record.traceId === logTrace.traceId && record.spanId === logTrace.spanId,
  );
  expect(run?.traceId).toBeTruthy();
  expect(run?.spanId).toBeTruthy();
  expect(model?.traceId).toBe(run?.traceId);
  expect(model?.parentSpanId).toBe(run?.spanId);
  expect(correlatedLog).toBeDefined();
}

test("flushes each private generation on restart and leaves global providers untouched", async () => {
  const receiverA = startLocalOtlpReceiver();
  const receiverB = startLocalOtlpReceiver();
  const portA = await receiverA.listen();
  const portB = await receiverB.listen();
  releaseOtelGlobals();
  const messages = captureOtelDiagnostics();
  const hostDiagOwner = registeredOtelGlobals()?.diag;
  process.env.OTEL_LOG_LEVEL = "debug";
  const globalProviders = {
    logs: registeredOtelLogs(),
    metrics: registeredOtelGlobals()?.metrics,
    trace: registeredOtelGlobals()?.trace,
  };
  function assertGeneration(receiver: typeof receiverA, logTrace: DiagnosticTraceContext) {
    expect(new Set(receiver.capturedRequests.map((request) => request.signal))).toEqual(
      new Set(["traces", "metrics", "logs"]),
    );
    expect(receiver.capturedMetrics.length).toBeGreaterThan(0);
    assertCorrelatedGeneration(receiver.capturedSpans, receiver.capturedLogRecords, logTrace);
    expect(registeredOtelGlobals()?.trace).toBe(globalProviders.trace);
    expect(registeredOtelGlobals()?.metrics).toBe(globalProviders.metrics);
    expect(registeredOtelLogs()).toBe(globalProviders.logs);
    expect(registeredOtelGlobals()?.diag).toBe(hostDiagOwner);
  }
  const service = createDiagnosticsOtelService();
  const flags = { traces: true, metrics: true, logs: true, flushIntervalMs: 60_000 };
  const ctxA = createOtelContext(`http://127.0.0.1:${portA}`, flags);
  const ctxB = createOtelContext(`http://127.0.0.1:${portB}`, flags);

  try {
    await service.start(ctxA);
    const traceA = await emitRealSdkSignals("generation-a");
    await service.stop?.(ctxA);
    const aRequestsAfterStop = receiverA.capturedRequests.length;

    assertGeneration(receiverA, traceA);

    await emitRealSdkSignals("after-a-stop");
    await sleep(50);
    expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);

    await service.start(ctxB);
    const traceB = await emitRealSdkSignals("generation-b");
    await service.stop?.(ctxB);
    const bRequestsAfterStop = receiverB.capturedRequests.length;

    expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);
    assertGeneration(receiverB, traceB);

    await emitRealSdkSignals("after-b-stop");
    await sleep(50);
    expect(receiverB.capturedRequests).toHaveLength(bRequestsAfterStop);
    diag.warn("host diagnostic logger remains active");
    expect(messages).toContain("host diagnostic logger remains active");
  } finally {
    await service.stop?.(ctxA);
    await service.stop?.(ctxB);
    await receiverA.close();
    await receiverB.close();
  }
}, 30_000);
