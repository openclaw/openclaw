---
summary: "Signal toggles, the diagnostics.otel field reference, OTEL_* environment variables, and sampling and flushing"
title: "OpenTelemetry configuration"
sidebarTitle: "Configuration"
read_when:
  - You are wiring traces, metrics, or logs into Grafana, Datadog, Honeycomb, New Relic, Tempo, or another OTLP backend
  - You need the endpoint, protocol, header, prefix, or exporter fields for `diagnostics.otel`
  - You are setting sampling, flush intervals, or the `OTEL_*` environment fallbacks
---

## Signals exported

| Signal      | What goes in it                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Metrics** | Counters/histograms for token usage, cost, run duration, failover, skill usage, message flow, Talk events, queue lanes, session state/recovery, tool execution, exec, memory, liveness, and exporter health. |
| **Traces**  | Spans for model usage, model calls, harness lifecycle, skill usage, tool execution, exec, webhook/message processing, context assembly, and tool loops.                                                      |
| **Logs**    | Structured `logging.file` records exported over OTLP or stdout JSONL when `diagnostics.otel.logs` is enabled; log bodies are withheld unless content capture is explicitly enabled.                          |

Toggle `traces`, `metrics`, and `logs` independently. Traces and metrics
default to on when `diagnostics.otel.enabled` is true; logs default to off
and export only when `diagnostics.otel.logs` is explicitly `true`. Log export
defaults to OTLP; set `diagnostics.otel.logsExporter` to `stdout` for JSONL on
stdout, or `both` for both.

<Note>
The shared `endpoint` and `OTEL_EXPORTER_OTLP_ENDPOINT` are bases for all
enabled signals. OpenClaw appends `/v1/traces`, `/v1/metrics`, or `/v1/logs`
to root and custom collector paths. For compatibility with hosted frontends,
a shared endpoint already ending in one of those signal paths keeps that path
for its matching signal and replaces the terminal segment for the others.

Signal-specific `tracesEndpoint`, `metricsEndpoint`, and `logsEndpoint`
settings, plus their matching `OTEL_EXPORTER_OTLP_*_ENDPOINT` fallbacks, are
passed to the exporter as exact URLs. OpenClaw does not append or rewrite their
paths.
</Note>

## Configuration reference

```json5
{
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "http://otel-collector:4318",
      tracesEndpoint: "http://otel-collector:4318/v1/traces",
      metricsEndpoint: "http://otel-collector:4318/v1/metrics",
      logsEndpoint: "http://otel-collector:4318/v1/logs",
      protocol: "http/protobuf",
      serviceName: "openclaw-gateway", // unset falls back to OTEL_SERVICE_NAME, then "openclaw"
      metricNamePrefix: "acme.", // optional; include the separator
      headers: { "x-collector-token": "..." },
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "otlp", // otlp | stdout | both
      sampleRate: 0.2, // root-span sampler, 0.0..1.0
      flushIntervalMs: 60000, // metric export interval (min 1000ms)
      captureContent: false,
    },
  },
}
```

`metricNamePrefix` replaces the default `openclaw.` prefix only on
OpenClaw-owned metrics. For example, `"acme."` exports `openclaw.tokens` as
`acme.tokens`; set it to `""` to export `tokens` with no prefix. Non-empty
values must start with an ASCII letter, use only letters, digits, underscores,
dots, hyphens, and slashes, and contain at most 128 characters. Set it to
`"acme.openclaw."` if you want `acme.openclaw.tokens`. Standard
semantic-convention metrics such as
`gen_ai.client.token.usage` and `gen_ai.client.operation.duration` keep their
original names. Leave the option unset to preserve every current metric name.
Enabling or changing this option renames the affected metric series, so update
dashboards, alerts, and recording rules that query the old names.

### Environment variables

| Variable                                                                                                                                                                                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                                                                                                                                          | Fallback for `diagnostics.otel.endpoint` when the config key is unset.                                                                                                                                                                                                                                                                                                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                                                                                                                      | Signal-specific endpoint fallbacks used when the matching `diagnostics.otel.*Endpoint` config key is unset. Signal-specific config wins over signal-specific env, which wins over the shared endpoint.                                                                                                                                                                           |
| `OTEL_SERVICE_NAME`                                                                                                                                                                                                                    | Fallback for `diagnostics.otel.serviceName` when the config key is unset. Default service name is `openclaw`.                                                                                                                                                                                                                                                                    |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                                                                                                                                                                                          | Shared process-environment fallback used when `diagnostics.otel.protocol` and the signal-specific protocol variable are unset. Only `http/protobuf` enables a plugin-owned OTLP exporter.                                                                                                                                                                                        |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` / `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`                                                                                                                      | Signal-specific protocol fallbacks used when `diagnostics.otel.protocol` is unset. A nonblank signal-specific value wins over the shared protocol value. Unsupported values disable only that plugin-owned OTLP signal.                                                                                                                                                          |
| `OTEL_PROPAGATORS`                                                                                                                                                                                                                     | Propagators registered for each plugin-owned generation, including when `OTEL_SDK_DISABLED=true`. Defaults to `tracecontext,baggage`; `none` disables automatic propagation. Values are case-insensitive. Unavailable values and deprecated `jaeger` usage emit a plugin warning.                                                                                                |
| `OTEL_SDK_DISABLED`                                                                                                                                                                                                                    | A case-insensitive `true` disables all plugin-owned trace, metric, log, and stdout routes before endpoint, protocol, or TLS setup. Any other value leaves the SDK enabled; unrecognized values emit a plugin warning and fall back to `false`. Async context and `OTEL_PROPAGATORS` remain active.                                                                               |
| `OTEL_NODE_RESOURCE_DETECTORS`                                                                                                                                                                                                         | Selects resource detectors for plugin-owned trace and metric providers. Supported tokens are `env`, `host`, `os`, `process`, and `serviceinstance`; `all` runs them in host, OS, service-instance, process, environment order, while `none` disables detection. The default is environment, process, then host. Explicit OpenClaw service config wins detector attributes.       |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`                                                                                                                                                                                      | Standard OpenTelemetry sampler selection used when `diagnostics.otel.sampleRate` is unset. An explicit `sampleRate` remains the higher-precedence OpenClaw sampler.                                                                                                                                                                                                              |
| `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_EVENT_COUNT_LIMIT` / `OTEL_SPAN_LINK_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT` | Standard OpenTelemetry span limits applied by each plugin-owned tracer provider.                                                                                                                                                                                                                                                                                                 |
| `OTEL_BSP_MAX_QUEUE_SIZE` / `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` / `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BSP_EXPORT_TIMEOUT`                                                                                                                   | Batch span processor settings for plugin-owned trace export. Values must be positive; invalid values use OpenTelemetry defaults. Export batch size is capped at queue size.                                                                                                                                                                                                      |
| `OTEL_METRIC_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_TIMEOUT`                                                                                                                                                                           | Periodic metric export interval and timeout for plugin-owned metrics. Values must be positive; invalid values use OpenTelemetry defaults, and timeout is capped at the active interval. `diagnostics.otel.flushIntervalMs` overrides the interval.                                                                                                                               |
| `OTEL_NODE_EXPERIMENTAL_SDK_METRICS`                                                                                                                                                                                                   | Enables OpenTelemetry SDK self-observation metrics for the private meter, tracer, and batch span processor when set to `true`.                                                                                                                                                                                                                                                   |
| `OTEL_LOG_LEVEL`                                                                                                                                                                                                                       | Owned mode does not replace the process-global OpenTelemetry diagnostic logger because the public SDK APIs expose no generation-private equivalent. A preload or host may configure this variable before OpenClaw starts; the plugin preserves that external diagnostic owner.                                                                                                   |
| `OTEL_SEMCONV_STABILITY_OPT_IN`                                                                                                                                                                                                        | Set to `gen_ai_latest_experimental` to emit the latest GenAI inference span shape: `{gen_ai.operation.name} {gen_ai.request.model}` span names, `CLIENT` span kind, and `gen_ai.provider.name` instead of the legacy `gen_ai.system`. GenAI metrics always use bounded, low-cardinality attributes regardless.                                                                   |
| `OPENCLAW_OTEL_PRELOADED`                                                                                                                                                                                                              | Set to `1` when another preload or host process already registered global OpenTelemetry providers. The plugin consumes external trace, metric, context, propagation, and logger ownership without registering, replacing, disabling, unregistering, or shutting it down. With `OTEL_SDK_DISABLED=true`, external ownership remains active while plugin-owned logs stay disabled. |

Without `OPENCLAW_OTEL_PRELOADED=1`, trace, metric, and log providers are
generation-private. The plugin publishes only its async context manager and
propagator through the public OpenTelemetry APIs, and removes them only while
those public behaviors still match the generation being stopped. A replacement
host or later generation therefore keeps ownership through cleanup.

## Sampling and flushing

- **Traces:** `diagnostics.otel.sampleRate` sets a `TraceIdRatioBasedSampler`
  on the root span only (`0.0` drops all, `1.0` keeps all). Unset uses the
  OpenTelemetry SDK default (always-on).
- **Metrics:** `diagnostics.otel.flushIntervalMs` (clamped to a minimum of
  `1000`); unset uses the SDK's periodic-export default.
- **Logs:** OTLP logs respect `logging.level` (file log level) and use the
  diagnostic log-record redaction path, not console formatting. High-volume
  installs should prefer OTLP collector sampling/filtering over local
  sampling. Set `diagnostics.otel.logsExporter: "stdout"` when your platform
  already ships stdout/stderr to a log processor and you have no OTLP logs
  collector. Stdout records are one JSON object per line with `ts`, `signal`,
  `service.name`, severity, body, redacted attributes, and trusted trace
  fields when available.
- **File-log correlation:** JSONL file logs include top-level `traceId`,
  `spanId`, `parentSpanId`, and `traceFlags` when the log call carries a valid
  diagnostic trace context, letting log processors join local log lines with
  exported spans.
- **Request correlation:** Gateway HTTP requests and WebSocket frames create
  an internal request trace scope. Logs and diagnostic events inside that
  scope inherit the request trace by default, while agent run and model-call
  spans are created as children so provider `traceparent` headers stay on the
  same trace.
- **Model-call correlation:** `openclaw.model.call` spans include safe prompt
  component sizes by default and per-call token attributes when the provider
  result exposes usage. `openclaw.model.usage` remains the run-level
  accounting span for aggregate cost, context, and channel dashboards, and
  stays on the same diagnostic trace when the emitting runtime has trusted
  trace context.
