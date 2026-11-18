import { context, propagation, type TextMapPropagator } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getStringListFromEnv,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { B3InjectEncoding, B3Propagator } from "@opentelemetry/propagator-b3";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";

const DEFAULT_PROPAGATORS = ["tracecontext", "baggage"];

function createConfiguredPropagator(warn: (message: string) => void): TextMapPropagator | null {
  const names = (getStringListFromEnv("OTEL_PROPAGATORS") ?? DEFAULT_PROPAGATORS).map((name) =>
    name.toLowerCase(),
  );
  if (names.includes("none")) {
    return null;
  }
  const propagators = [...new Set(names)].flatMap((name): TextMapPropagator[] => {
    switch (name) {
      case "tracecontext":
        return [new W3CTraceContextPropagator()];
      case "baggage":
        return [new W3CBaggagePropagator()];
      case "b3":
        return [new B3Propagator()];
      case "b3multi":
        return [new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER })];
      case "jaeger":
        warn(
          'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.',
        );
        return [new JaegerPropagator()];
      default:
        warn(`Propagator "${name}" requested through environment variable is unavailable.`);
        return [];
    }
  });
  if (propagators.length === 0) {
    return null;
  }
  return propagators.length === 1 ? propagators[0]! : new CompositePropagator({ propagators });
}

export function registerOwnedSdkRuntime(warn: (message: string) => void): (() => void) | null {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const ownsContext = context.setGlobalContextManager(contextManager);
  if (!ownsContext) {
    contextManager.disable();
  }
  const propagator = createConfiguredPropagator(warn);
  const ownsPropagation = propagator ? propagation.setGlobalPropagator(propagator) : false;
  if (!ownsContext && !ownsPropagation) {
    return null;
  }
  // Preloaded globals stay external. Replacing these globals while the service
  // is running is best effort; stop this service before installing another SDK.
  return () => {
    if (ownsPropagation) {
      propagation.disable();
    }
    if (ownsContext) {
      context.disable();
    }
  };
}
