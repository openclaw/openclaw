/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  propagation,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

// OpenTelemetry JS 3 removed @opentelemetry/propagator-jaeger (open-telemetry/opentelemetry-js#7077),
// and its last 2.x release cannot share @opentelemetry/api 1.10 with the 3.x SDK. This keeps the
// deprecated OTEL_PROPAGATORS=jaeger wire format of that release: `uber-trace-id` carries
// `{trace-id}:{span-id}:0:{flags}` and baggage travels as percent-encoded `uberctx-<key>` headers.
const UBER_TRACE_ID_HEADER = "uber-trace-id";
const UBER_BAGGAGE_HEADER_PREFIX = "uberctx-";
const FLAGS_PATTERN = /^[0-9a-f]{1,2}$/i;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseUberTraceId(value: string): SpanContext | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4) {
    return undefined;
  }
  const [traceId = "", spanId = "", , flags = ""] = parts;
  return {
    traceId: traceId.padStart(32, "0"),
    spanId: spanId.padStart(16, "0"),
    isRemote: true,
    // Jaeger's debug bit is not an OpenTelemetry trace flag; unparsable flags default to sampled.
    traceFlags: FLAGS_PATTERN.test(flags)
      ? Number.parseInt(flags, 16) & TraceFlags.SAMPLED
      : TraceFlags.SAMPLED,
  };
}

export class JaegerPropagator implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context);
    if (spanContext && !isTracingSuppressed(context)) {
      const flags = `0${(spanContext.traceFlags || TraceFlags.NONE).toString(16)}`;
      setter.set(
        carrier,
        UBER_TRACE_ID_HEADER,
        `${spanContext.traceId}:${spanContext.spanId}:0:${flags}`,
      );
    }
    for (const [key, entry] of propagation.getBaggage(context)?.getAllEntries() ?? []) {
      setter.set(carrier, `${UBER_BAGGAGE_HEADER_PREFIX}${key}`, encodeURIComponent(entry.value));
    }
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    let extracted = context;
    const uberTraceId = firstValue(getter.get(carrier, UBER_TRACE_ID_HEADER));
    const spanContext = uberTraceId === undefined ? undefined : parseUberTraceId(uberTraceId);
    if (spanContext) {
      extracted = trace.setSpanContext(extracted, spanContext);
    }
    const baggageKeys = getter
      .keys(carrier)
      .filter((key) => key.startsWith(UBER_BAGGAGE_HEADER_PREFIX));
    if (baggageKeys.length === 0) {
      return extracted;
    }
    let baggage = propagation.getBaggage(context) ?? propagation.createBaggage();
    for (const key of baggageKeys) {
      const value = firstValue(getter.get(carrier, key));
      if (value === undefined) {
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        continue;
      }
      baggage = baggage.setEntry(key.slice(UBER_BAGGAGE_HEADER_PREFIX.length), { value: decoded });
    }
    return propagation.setBaggage(extracted, baggage);
  }

  fields(): string[] {
    return [UBER_TRACE_ID_HEADER];
  }
}
