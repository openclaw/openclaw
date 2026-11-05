import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  parseDiagnosticTraceparent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, onTestFinished, test, vi } from "vitest";
import { runModelCallAndCaptureTraceparent } from "../../../test/e2e/qa-lab/runtime/otel-model-call.test-support.js";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import {
  captureOtelDiagnostics,
  collectTestMetrics,
  installRealOtelSdkTestHarness,
  installTestMeter,
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

function releasePreloadedOtelGlobals() {
  clearOtelGlobals();
  process.env[PRELOAD_ENV] = "0";
}

async function collectSignals(
  configure: (ctx: ReturnType<typeof createOtelContext>, endpoint: string) => void,
  flags = { traces: true, metrics: true, logs: true },
) {
  const receiver = await startOtlpReceiver();
  onTestFinished(() => receiver.close());
  releasePreloadedOtelGlobals();
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    ...flags,
    configure: (serviceContext) => configure(serviceContext, receiver.endpoint),
  });
  await emitRealSdkSignals();
  await service.stop?.(ctx);
  return { requests: receiver.requests, ctx };
}

const completed = { outcome: "completed", durationMs: 80 } as const;
const runBase = { runId: "run-otlp", provider: "openai", model: "gpt-5.6-luna" };

test("bounds tool metric series across collections while preserving span parameter lengths", async () => {
  const { reader } = installTestMeter();
  const paramsKey = "openclaw.tool.params";
  await startOtelService({ traces: true, metrics: true });
  for (const iteration of [1, 2]) {
    for (const paramsSummary of [
      { kind: "string", length: iteration * 3 },
      { kind: "array", length: iteration * 5 },
    ] as const) {
      const tool = { toolName: "read", paramsSummary };
      emit({ type: "tool.execution.completed", ...tool, durationMs: 17 });
      emit({ type: "tool.execution.blocked", ...tool, deniedReason: "policy", reason: "Blocked" });
    }
    await waitForDiagnosticEventsDrained();
    const exported = await collectTestMetrics(reader, "openclaw.tool.execution.");
    if (iteration !== 2) {
      continue;
    }
    for (const suffix of ["duration_ms", "blocked"]) {
      const points = exported.find((metric) => metric.descriptor.name.endsWith(suffix))?.dataPoints;
      expect(points).toHaveLength(2);
      const kinds = points?.map((point) => point.attributes[`${paramsKey}.kind`]).toSorted();
      expect(kinds).toEqual(["array", "string"]);
      for (const point of points ?? []) {
        expect(point.attributes).not.toHaveProperty(`${paramsKey}.length`);
        expect(typeof point.value === "number" ? point.value : point.value.count).toBe(2);
      }
    }
  }
  await sdk.provider.forceFlush();
  expect(
    sdk.exporter
      .getFinishedSpans()
      .map((span) => span.attributes[`${paramsKey}.length`])
      .toSorted((a, b) => Number(a) - Number(b)),
  ).toEqual([3, 3, 5, 5, 6, 6, 10, 10]);
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
      expect(request.method).toBe("POST");
      expect(request.contentType).toBe("application/x-protobuf");
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

test.each(["completed", "error"] as const)(
  "propagates a rooted OTLP trace with late children after %s",
  async (outcome) => {
    const receiver = startLocalOtlpReceiver();
    const port = await receiver.listen();
    const endpoint = `http://127.0.0.1:${port}`;
    releasePreloadedOtelGlobals();

    const peerProvider = new BasicTracerProvider({
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

    const { service, ctx } = await startOtelService({ endpoint, traces: true });

    try {
      const message = { channel: "web", trace: createChildDiagnosticTraceContext(inboundParent) };
      const harness = {
        ...runBase,
        harnessId: "openclaw",
        trace: createChildDiagnosticTraceContext(message.trace),
      };
      const run = { ...runBase, trace: createChildDiagnosticTraceContext(harness.trace) };
      emit({ type: "message.dispatch.started", ...message, source: "http" });
      emit({ type: "harness.run.started", ...harness });
      emit({ type: "run.started", ...run });
      const outboundTraceparent = await runModelCallAndCaptureTraceparent({
        ...run,
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

      emit({ type: "run.completed", ...run, ...completed });
      if (outcome === "completed") {
        emit({ type: "harness.run.completed", ...harness, ...completed });
      } else {
        emit({
          type: "harness.run.error",
          ...harness,
          phase: "send",
          errorCategory: "aborted",
          durationMs: 80,
        });
      }
      const tool = {
        runId: runBase.runId,
        toolName: "http",
        trace: createChildDiagnosticTraceContext(
          outcome === "completed" ? run.trace : harness.trace,
        ),
      };
      if (outcome === "completed") {
        emit({ type: "tool.execution.started", ...tool });
      }
      emit({ type: "tool.execution.completed", ...tool, durationMs: 10 });
      emit({
        type: "context.assembled",
        ...runBase,
        trace: createChildDiagnosticTraceContext(harness.trace),
        messageCount: 3,
        historyTextChars: 100,
        historyImageBlocks: 0,
        maxMessageTextChars: 100,
        systemPromptChars: 50,
        promptChars: 150,
        promptImages: 0,
      });
      emit({ type: "message.processed", ...message, ...completed });
      emit({
        type: "model.usage",
        ...runBase,
        usage: { input: 10, output: 5, total: 15 },
        durationMs: 30,
        trace: createChildDiagnosticTraceContext(message.trace),
      });
      await waitForDiagnosticEventsDrained();
      peerRoot.end();
      await service.stop?.(ctx);
      await peerProvider.shutdown();

      const spans = receiver.capturedSpans;
      const spanIds = new Set(spans.map((span) => span.spanId));
      const roots = spans.filter((span) => !span.parentSpanId);
      const modelSpan = spans.find((span) => span.name === "openclaw.model.call");

      expect(spans).toHaveLength(9);
      expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
      expect(roots.map((span) => span.name)).toEqual(["peer.request"]);
      expect(spans.every((span) => !span.parentSpanId || spanIds.has(span.parentSpanId))).toBe(
        true,
      );
      const { traceId, spanId } = modelSpan ?? {};
      expect(outboundContext).toMatchObject({ traceId, spanId });
      expect(spans.find((span) => span.name === "peer.callback")?.parentSpanId).toBe(spanId);
      const id = (name: string) => spans.find((span) => span.name === `openclaw.${name}`)?.spanId;
      expect(Object.fromEntries(spans.map((span) => [span.name, span.parentSpanId]))).toMatchObject(
        {
          "openclaw.harness.run": id("message.processed"),
          "openclaw.run": id("harness.run"),
          "openclaw.tool.execution": id(outcome === "completed" ? "run" : "harness.run"),
          "openclaw.context.assembled": id("harness.run"),
          "openclaw.model.usage": id("message.processed"),
        },
      );
    } finally {
      peerRoot.end();
      await service.stop?.(ctx);
      await peerProvider.shutdown();
      await receiver.close();
    }
  },
  30_000,
);

test("exports cache-write TTL facts without duplicate generic usage", async () => {
  await startOtelService({ traces: true });
  for (const usage of [
    { cacheWrite: 1_000_000, cacheWrite1h: 400_000, cacheWrite5m: 600_000 },
    { cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0 },
    { cacheWrite: 1_000_000 },
  ]) {
    emit({
      type: "model.call.completed",
      ...runBase,
      callId: "cache-write",
      durationMs: 10,
      usage,
    });
  }
  await waitForDiagnosticEventsDrained();
  const attrs = sdk.exporter.getFinishedSpans().map((span) => span.attributes);
  const generic = "gen_ai.usage.cache_creation.input_tokens";
  const local = "openclaw.model_call.usage.cache_creation_input_tokens";
  expect(attrs.map((a) => [a[generic], a[local], a[`${local}_1h`], a[`${local}_5m`]])).toEqual([
    [1_000_000, 1_000_000, 400_000, 600_000],
    [0, 0, 0, 0],
    [1_000_000, 1_000_000, undefined, undefined],
  ]);
  // Generic consumers price every bucket, so TTL subsets must stay OpenClaw-only.
  const ttlKeys = [generic, local, `${local}_1h`, `${local}_5m`].toSorted();
  expect(
    attrs.map((a) =>
      Object.keys(a)
        .filter((key) => key.includes("cache_creation"))
        .toSorted(),
    ),
  ).toEqual([ttlKeys, ttlKeys, [generic, local].toSorted()]);
});

test("leaves message and exec spans parentless when no ancestor was exported", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const requestScope = createDiagnosticTraceContext();
  emit({ type: "message.processed", channel: "web", ...completed, trace: requestScope });
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

  const spans = sdk.exporter.getFinishedSpans();
  expect(spans.map((span) => span.name)).toEqual(["openclaw.message.processed", "openclaw.exec"]);
  for (const span of spans) {
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(requestScope.traceId);
  }
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
  await startupService(ctx).start(ctx);
  expect(diagnostics.join("\n")).not.toContain(credential);
});

const UNREADABLE_TLS_ERROR =
  "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export";

function startupService(ctx: ReturnType<typeof createOtelContext>) {
  ctx.internalDiagnostics!.emit = () => {};
  const service = createDiagnosticsOtelService();
  onTestFinished(() => service.stop?.(ctx));
  return service;
}

async function expectSafeStartupFailure(
  ctx: ReturnType<typeof createOtelContext>,
  sentinel: string,
  message: string,
) {
  const diagnostics = captureOtelDiagnostics();
  const failure = await Promise.resolve()
    .then(() => startupService(ctx).start(ctx))
    .catch((error: unknown) => error);
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

test.each(["missing", "default-endpoint", "untrimmed", "empty", "mTLS"] as const)(
  "rejects %s TLS material without exposing its path",
  async (kind) => {
    process.env[PRELOAD_ENV] = "0";
    const sentinel = "qa-otel-certificate-path";
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-tls-"));
    onTestFinished(() => rmSync(certDir, { force: true, recursive: true }));
    const certificate = {
      missing: path.join(certDir, `${sentinel}-missing.pem`),
      "default-endpoint": path.join(certDir, `${sentinel}-missing.pem`),
      untrimmed: ` ${process.execPath} `,
      empty: path.join(certDir, `${sentinel}-empty.pem`),
      mTLS: process.execPath,
    }[kind];
    if (kind === "empty") {
      writeFileSync(certificate, "");
    }
    process.env[
      `OTEL_EXPORTER_OTLP_TRACES_${kind === "mTLS" ? "CLIENT_CERTIFICATE" : "CERTIFICATE"}`
    ] = certificate;
    await expectSafeStartupFailure(
      createOtelContext(kind === "default-endpoint" ? "" : collector, { traces: true }),
      certificate,
      kind === "mTLS"
        ? "Configured OpenTelemetry mTLS requires both a client certificate and private key; refusing insecure export"
        : UNREADABLE_TLS_ERROR,
    );
  },
);

test("flushes each private generation on restart and leaves global providers untouched", async () => {
  const receivers = [startLocalOtlpReceiver(), startLocalOtlpReceiver()];
  const contexts: ReturnType<typeof createOtelContext>[] = [];
  for (const receiver of receivers) {
    contexts.push(
      createOtelContext(`http://127.0.0.1:${await receiver.listen()}`, {
        traces: true,
        metrics: true,
        logs: true,
        flushIntervalMs: 60_000,
      }),
    );
  }
  releasePreloadedOtelGlobals();
  const messages = captureOtelDiagnostics();
  process.env.OTEL_LOG_LEVEL = "debug";
  const globals = { ...registeredOtelGlobals() };
  const logs = registeredOtelLogs();
  const service = createDiagnosticsOtelService();
  const requestCounts: number[] = [];
  try {
    process.env.OTEL_SDK_DISABLED = "true";
    await service.start(contexts[0]!);
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    await service.stop?.(contexts[0]!);
    process.env.OTEL_SDK_DISABLED = "false";
    for (const [index, ctx] of contexts.entries()) {
      const receiver = receivers[index]!;
      await service.start(ctx);
      expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
      const logTrace = await emitRealSdkSignals(`generation-${index}`);
      await service.stop?.(ctx);
      requestCounts.push(receiver.capturedRequests.length);
      expect(new Set(receiver.capturedRequests.map((request) => request.signal))).toEqual(
        new Set(["traces", "metrics", "logs"]),
      );
      expect(receiver.capturedMetrics.length).toBeGreaterThan(0);
      const run = receiver.capturedSpans.find((span) => span.name === "openclaw.run");
      expect(run?.traceId).toBeTruthy();
      expect(run?.spanId).toBeTruthy();
      expect(
        receiver.capturedSpans.find((span) => span.name === "openclaw.model.call"),
      ).toMatchObject({ traceId: run?.traceId, parentSpanId: run?.spanId });
      expect(
        receiver.capturedLogRecords.find(
          (record) => record.traceId === logTrace.traceId && record.spanId === logTrace.spanId,
        ),
      ).toBeDefined();
      for (const key of ["trace", "metrics", "diag"] as const) {
        expect(registeredOtelGlobals()?.[key]).toBe(globals[key]);
      }
      expect(registeredOtelLogs()).toBe(logs);
      await emitRealSdkSignals(`after-${index}-stop`);
      await sleep(50);
      expect(receivers.slice(0, index + 1).map((item) => item.capturedRequests.length)).toEqual(
        requestCounts,
      );
    }
    diag.warn("host diagnostic logger remains active");
    expect(messages).toContain("host diagnostic logger remains active");
  } finally {
    for (const ctx of contexts) {
      await service.stop?.(ctx);
    }
    for (const receiver of receivers) {
      await receiver.close();
    }
  }
}, 30_000);
