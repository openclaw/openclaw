import { setImmediate as nextTurn } from "node:timers/promises";
import { type Tracer, trace, TraceFlags } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { clearOtelGlobals } from "./service.test-helpers.js";

const ENV_KEYS = [
  "OTEL_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_SPAN_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_LINK_COUNT_LIMIT",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
] as const;

installRealOtelSdkTestHarness({ env: ENV_KEYS });
beforeEach(() => clearOtelGlobals());

async function capturePrivateProviderSpans(emit: (tracer: Tracer) => void) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({}),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  emit(provider.getTracer("openclaw-private-provider-parity"));
  await provider.forceFlush();
  const spans = [...exporter.getFinishedSpans()];
  await provider.shutdown();
  return spans;
}

async function captureNodeSdkSpans(emit: (tracer: Tracer) => void) {
  const exporter = new InMemorySpanExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({}),
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  sdk.start();
  emit(trace.getTracer("openclaw-node-sdk-parity"));
  await nextTurn();
  const spans = [...exporter.getFinishedSpans()];
  await sdk.shutdown();
  clearOtelGlobals();
  return spans;
}

const SAMPLER_CASES: ReadonlyArray<[string | undefined, number, string?]> = [
  [undefined, 1],
  ["always_on", 1],
  ["always_off", 0],
  ["parentbased_always_on", 1],
  ["parentbased_always_off", 0],
  ["traceidratio", 1, "1"],
  ["traceidratio", 0, "0"],
  ["parentbased_traceidratio", 1, "1"],
  ["parentbased_traceidratio", 0, "0"],
  ["invalid", 1],
  ["traceidratio", 1, "-1"],
];

test.each(SAMPLER_CASES)(
  "matches NodeSDK sampler %s (expected=%s, ratio=%s)",
  async (sampler, expected, arg) => {
    if (sampler !== undefined) {
      process.env.OTEL_TRACES_SAMPLER = sampler;
    }
    if (arg !== undefined) {
      process.env.OTEL_TRACES_SAMPLER_ARG = arg;
    }
    const emit = (tracer: Tracer) => tracer.startSpan("sampler-probe").end();
    expect(await captureNodeSdkSpans(emit)).toHaveLength(expected);
    expect(await capturePrivateProviderSpans(emit)).toHaveLength(expected);
  },
);

function emitLimitProbe(tracer: Tracer): void {
  const attributes = { first: "abcdef", second: "ghijkl" };
  const span = tracer.startSpan("limit-probe", {
    attributes,
    links: ["1", "2"].map((digit) => ({
      context: {
        traceId: digit.repeat(32),
        spanId: digit.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      },
      attributes,
    })),
  });
  span.addEvent("first", attributes);
  span.addEvent("second", attributes);
  span.end();
}

function spanLimitShape(span: ReadableSpan) {
  return {
    attributes: span.attributes,
    events: span.events.map((event) => event.attributes),
    links: span.links.map((link) => link.attributes),
  };
}

test("matches NodeSDK behavior for all six OTEL_SPAN_* limit variables", async () => {
  process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = "3";
  process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_LINK_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT = "1";

  const [nodeSdkSpan] = await captureNodeSdkSpans(emitLimitProbe);
  const [privateProviderSpan] = await capturePrivateProviderSpans(emitLimitProbe);
  if (!nodeSdkSpan || !privateProviderSpan) {
    throw new Error("expected both providers to export the limit probe");
  }
  const expectedShape = {
    attributes: { first: "abc" },
    events: [{ first: "abc" }],
    links: [{ first: "abc" }],
  };

  expect(spanLimitShape(nodeSdkSpan)).toEqual(expectedShape);
  expect(spanLimitShape(privateProviderSpan)).toEqual(expectedShape);
});
