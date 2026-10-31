import {
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { expect, test } from "vitest";
import { JaegerPropagator } from "./service-jaeger-propagator.js";

// Expected bytes match @opentelemetry/propagator-jaeger 2.12.0, the last published release.
const propagator = new JaegerPropagator();
const TRACE_ID = "d4cda95b652f4a1592b449d5929fda1b";
const SPAN_ID = "6e0c63257de34c92";

function inject(context: Context) {
  const carrier: Record<string, string> = {};
  propagator.inject(context, carrier, defaultTextMapSetter);
  return carrier;
}

function extract(carrier: Record<string, string | string[]>) {
  const context = propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
  const entries = propagation.getBaggage(context)?.getAllEntries() ?? [];
  return {
    spanContext: trace.getSpanContext(context),
    baggage: Object.fromEntries(entries.map(([key, entry]) => [key, entry.value])),
  };
}

test("injects uber-trace-id and uberctx baggage headers", () => {
  const baggage = propagation.createBaggage({ "user id": { value: "a b/ü" } });
  const spanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
  const sampled = trace.setSpanContext(propagation.setBaggage(ROOT_CONTEXT, baggage), spanContext);

  expect(inject(sampled)).toEqual({
    "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:01`,
    "uberctx-user id": "a%20b%2F%C3%BC",
  });
  expect(
    inject(trace.setSpanContext(ROOT_CONTEXT, { ...spanContext, traceFlags: TraceFlags.NONE })),
  ).toEqual({ "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:00` });
  expect(inject(suppressTracing(sampled))).toEqual({ "uberctx-user id": "a%20b%2F%C3%BC" });
  expect(propagator.fields()).toEqual(["uber-trace-id"]);
});

test.each<[string, Record<string, string | string[]>, ReturnType<typeof extract>]>([
  [
    "a percent-encoded 64-bit trace id with the debug bit",
    { "uber-trace-id": encodeURIComponent(`${TRACE_ID.slice(16)}:${SPAN_ID}:0:3`) },
    {
      spanContext: {
        traceId: TRACE_ID.slice(16).padStart(32, "0"),
        spanId: SPAN_ID,
        isRemote: true,
        traceFlags: TraceFlags.SAMPLED,
      },
      baggage: {},
    },
  ],
  [
    "an unsampled first header value",
    { "uber-trace-id": [`${TRACE_ID}:${SPAN_ID}:0:0`, `${TRACE_ID}:${SPAN_ID}:0:1`] },
    {
      spanContext: { traceId: TRACE_ID, spanId: SPAN_ID, isRemote: true, traceFlags: 0 },
      baggage: {},
    },
  ],
  [
    "unparsable flags as sampled",
    { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:zz` },
    {
      spanContext: { traceId: TRACE_ID, spanId: SPAN_ID, isRemote: true, traceFlags: 1 },
      baggage: {},
    },
  ],
  [
    "baggage without a malformed trace id or value",
    {
      "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:01`,
      "uberctx-user id": "a%20b%2F%C3%BC",
      "uberctx-broken": "%E0%A4%A",
    },
    { spanContext: undefined, baggage: { "user id": "a b/ü" } },
  ],
])("extracts %s", (_name, carrier, expected) => {
  expect(extract(carrier)).toEqual(expected);
});
