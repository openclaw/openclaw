import { diag } from "@opentelemetry/api";
import { getNumberFromEnv, getStringFromEnv } from "@opentelemetry/core";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  type SpanLimits,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";

// SDK 3 tracer providers no longer read OTEL_TRACES_SAMPLER or the span-limit variables. Plugin-owned
// providers keep the documented NodeSDK-compatible environment contract that sdk-trace-base 2.x
// applied, including its diagnostic messages.
function readSamplerRatioFromEnv(): number {
  const ratio = getNumberFromEnv("OTEL_TRACES_SAMPLER_ARG");
  if (ratio === undefined) {
    diag.error("OTEL_TRACES_SAMPLER_ARG is blank, defaulting to 1.");
    return 1;
  }
  if (ratio < 0 || ratio > 1) {
    diag.error(
      `OTEL_TRACES_SAMPLER_ARG=${ratio} was given, but it is out of range ([0..1]), defaulting to 1.`,
    );
    return 1;
  }
  return ratio;
}

function resolveEnvSampler(): Sampler | undefined {
  const sampler = getStringFromEnv("OTEL_TRACES_SAMPLER");
  switch (sampler) {
    case undefined:
    case "parentbased_always_on":
      return undefined;
    case "always_on":
      return new AlwaysOnSampler();
    case "always_off":
      return new AlwaysOffSampler();
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "traceidratio":
      return new TraceIdRatioBasedSampler(readSamplerRatioFromEnv());
    case "parentbased_traceidratio":
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(readSamplerRatioFromEnv()),
      });
    default:
      diag.error(
        `OTEL_TRACES_SAMPLER value "${sampler}" invalid, defaulting to "parentbased_always_on".`,
      );
      return undefined;
  }
}

// An explicit diagnostics.otel.sampleRate wins over OTEL_TRACES_SAMPLER. Undefined keeps the SDK's
// default parent-based always-on sampler.
export function resolveTraceSampler(sampleRate: number | undefined): Sampler | undefined {
  return sampleRate === undefined
    ? resolveEnvSampler()
    : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate) });
}

export function readSpanLimitsFromEnv(): SpanLimits {
  return {
    attributeCountLimit:
      getNumberFromEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT") ??
      getNumberFromEnv("OTEL_ATTRIBUTE_COUNT_LIMIT"),
    attributeValueLengthLimit:
      getNumberFromEnv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT") ??
      getNumberFromEnv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"),
    eventCountLimit: getNumberFromEnv("OTEL_SPAN_EVENT_COUNT_LIMIT"),
    linkCountLimit: getNumberFromEnv("OTEL_SPAN_LINK_COUNT_LIMIT"),
    attributePerEventCountLimit: getNumberFromEnv("OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT"),
    attributePerLinkCountLimit: getNumberFromEnv("OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT"),
  };
}
