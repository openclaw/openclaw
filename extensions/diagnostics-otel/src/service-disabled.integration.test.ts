import { setImmediate as nextTurn } from "node:timers/promises";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  clearOtelGlobals,
  snapshotOtelEnv,
  emitRealSdkSignals,
  getReportedExporterHealth,
  startOtelService,
  TRACE_ID,
  SPAN_ID,
} from "./service.test-helpers.js";

installRealOtelSdkTestHarness();

const ENV_KEYS = ["OTEL_PROPAGATORS"] as const;
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
  roundtrip("B3MULTI", {
    "x-b3-traceid": TRACE_ID,
    "x-b3-spanid": SPAN_ID,
    "x-b3-sampled": "1",
  }),
  roundtrip(
    "JaEgEr",
    { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:1` },
    {
      "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:01`,
    },
  ),
] as const;

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = snapshotOtelEnv(ENV_KEYS);
  clearOtelGlobals();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.OPENCLAW_OTEL_PRELOADED = "0";
});
afterEach(() => restoreEnv());

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
    const incoming = {
      baggage: "tenant=example",
      ...W3C_CARRIER,
    };
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
  {
    value: "NoNe",
    fields: [],
  },
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
