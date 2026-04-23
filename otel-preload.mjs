import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "openclaw-gateway",
  }),
  textMapPropagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT 
      ? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith("/v1/traces") 
          ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT 
          : `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`)
      : "http://otel-collector:4318/v1/traces",
  }),
});

sdk.start();
process.env.OPENCLAW_OTEL_PRELOADED = "1";

const shutdown = () => {
  sdk.shutdown()
    .then(() => console.log("OTel SDK shut down"))
    .catch((err) => console.log("Error shutting down OTel SDK", err))
    .finally(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
