import { trace, metrics } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint = "http://localhost:5080/api/default";
const headers = {
  Authorization: "Basic YmxzcGVhckBnbWFpbC5jb206T3Blbk9ic2VydmVMb2NhbDEyMw==",
};

const resource = resourceFromAttributes({ "service.name": "otel-test" });

const traceExporter = new OTLPTraceExporter({
  url: `${endpoint}/v1/traces`,
  headers,
});

const metricExporter = new OTLPMetricExporter({
  url: `${endpoint}/v1/metrics`,
  headers,
});

const logExporter = new OTLPLogExporter({
  url: `${endpoint}/v1/logs`,
  headers,
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 2000,
});

const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader,
});

sdk.start();

// Set up logs
const logProcessor = new BatchLogRecordProcessor(logExporter, {
  scheduledDelayMillis: 2000,
});
const logProvider = new LoggerProvider({ resource, processors: [logProcessor] });
const logger = logProvider.getLogger("test");

// Create a test trace
const tracer = trace.getTracer("test");
const span = tracer.startSpan("test-span", {
  attributes: { "test.key": "hello-openobserve" },
});
span.end();
console.log("Created test span");

// Create a test metric
const meter = metrics.getMeter("test");
const counter = meter.createCounter("test.requests");
counter.add(1, { "test.env": "local" });
console.log("Created test metric");

// Create a test log
logger.emit({
  body: "Test log message from OTEL",
  severityText: "INFO",
  severityNumber: 9,
  attributes: { "test.source": "otel-test-script" },
});
console.log("Created test log");

// Wait for flush
console.log("Waiting 5s for flush...");
await new Promise((r) => setTimeout(r, 5000));

await logProvider.shutdown();
await sdk.shutdown();
console.log("Done - check OpenObserve for streams");
