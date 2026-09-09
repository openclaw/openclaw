---
summary: "Index of the OpenClaw OpenTelemetry export documentation, one page per reader job"
title: "OpenTelemetry export"
sidebarTitle: "OpenTelemetry export"
read_when:
  - You want to send OpenClaw model usage, message flow, or session metrics to an OpenTelemetry collector
  - You are wiring traces, metrics, or logs into Grafana, Datadog, Honeycomb, New Relic, Tempo, or another OTLP backend
  - You need the exact metric names, span names, or attribute shapes to build dashboards or alerts
---

OpenClaw exports diagnostics through the official `diagnostics-otel` plugin
using **OTLP/HTTP (protobuf)**. Logs can also be written as stdout JSONL for
container and sandbox log pipelines. Any collector or backend that accepts
OTLP/HTTP works without code changes. For local file logs, see
[Logging](/logging).

- **Diagnostics events** are structured, in-process records emitted by the
  Gateway and bundled plugins for model runs, message flow, sessions, queues,
  and exec.
- **`diagnostics-otel`** subscribes to those events and exports them as
  OpenTelemetry **metrics**, **traces**, and **logs** over OTLP/HTTP, and can
  mirror log records to stdout JSONL.
- **Provider calls** receive a W3C `traceparent` header from the actual current
  OpenTelemetry model-call span when the provider transport accepts custom
  headers. Diagnostic IDs remain local correlation keys, and plugin-emitted
  trace context is not propagated.
- Exporters attach only when both the diagnostics surface and the plugin are
  enabled, so in-process cost stays near zero by default.

This page is an index. OpenTelemetry export is documented on five pages, one
per reader job. Open the page that matches your task.

| Page                                                                               | Read it when                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Set up OpenTelemetry export](/gateway/opentelemetry/setup)                        | You want to install the plugin, turn export on, check exporter health, or turn it off.          |
| [OpenTelemetry configuration](/gateway/opentelemetry/configuration)                | You need the `diagnostics.otel` fields, the `OTEL_*` variables, or sampling and flush settings. |
| [Privacy and trace context](/gateway/opentelemetry/privacy-and-trace-context)      | You need to know what content leaves the process, or want to continue an upstream trace.        |
| [Model calls and exported metrics](/gateway/opentelemetry/model-calls-and-metrics) | You are building dashboards or alerts and need exact metric names and attributes.               |
| [Exported spans and diagnostic events](/gateway/opentelemetry/spans-and-events)    | You are reading traces or subscribing a plugin to diagnostic events.                            |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/gateway/opentelemetry#gateway-rpc` still resolves. Each entry
points at the page that now holds the content.

- <a id="quick-start" />[Quick start](/gateway/opentelemetry/setup#quick-start)
- <a id="signals-exported" />[Signals exported](/gateway/opentelemetry/configuration#signals-exported)
- <a id="which-processes-export" />[Which processes export](/gateway/opentelemetry/setup#which-processes-export)
- <a id="exporter-health" />[Exporter health](/gateway/opentelemetry/setup#exporter-health)
- <a id="configuration-reference" />[Configuration reference](/gateway/opentelemetry/configuration#configuration-reference)
- <a id="environment-variables" />[Environment variables](/gateway/opentelemetry/configuration#environment-variables)
- <a id="continue-an-upstream-websocket-trace" />[Continue an upstream WebSocket trace](/gateway/opentelemetry/privacy-and-trace-context#continue-an-upstream-websocket-trace)
- <a id="privacy-and-content-capture" />[Privacy and content capture](/gateway/opentelemetry/privacy-and-trace-context#privacy-and-content-capture)
- <a id="sampling-and-flushing" />[Sampling and flushing](/gateway/opentelemetry/configuration#sampling-and-flushing)
- <a id="model-call-observation-units" />[Model-call observation units](/gateway/opentelemetry/model-calls-and-metrics#model-call-observation-units)
- <a id="claude-code-cli-model-call-fidelity" />[Claude Code CLI model-call fidelity](/gateway/opentelemetry/model-calls-and-metrics#claude-code-cli-model-call-fidelity)
- <a id="exported-metrics" />[Exported metrics](/gateway/opentelemetry/model-calls-and-metrics#exported-metrics)
- <a id="gateway-rpc" />[Gateway RPC](/gateway/opentelemetry/model-calls-and-metrics#gateway-rpc)
- <a id="model-usage" />[Model usage](/gateway/opentelemetry/model-calls-and-metrics#model-usage)
- <a id="message-flow" />[Message flow](/gateway/opentelemetry/model-calls-and-metrics#message-flow)
- <a id="talk" />[Talk](/gateway/opentelemetry/model-calls-and-metrics#talk)
- <a id="queues-and-sessions" />[Queues and sessions](/gateway/opentelemetry/model-calls-and-metrics#queues-and-sessions)
- <a id="session-liveness-telemetry" />[Session liveness telemetry](/gateway/opentelemetry/model-calls-and-metrics#session-liveness-telemetry)
- <a id="gateway-event-loop-observation-windows" />[Gateway event-loop observation windows](/gateway/opentelemetry/model-calls-and-metrics#gateway-event-loop-observation-windows)
- <a id="harness-lifecycle" />[Harness lifecycle](/gateway/opentelemetry/model-calls-and-metrics#harness-lifecycle)
- <a id="tool-execution-and-loop-detection" />[Tool execution and loop detection](/gateway/opentelemetry/model-calls-and-metrics#tool-execution-and-loop-detection)
- <a id="exec" />[Exec](/gateway/opentelemetry/model-calls-and-metrics#exec)
- <a id="diagnostics-internals-(memory%2C-payloads%2C-exporter-health)" /><a id="diagnostics-internals-memory-payloads-exporter-health" />[Diagnostics internals (memory, payloads, exporter health)](/gateway/opentelemetry/model-calls-and-metrics#diagnostics-internals-memory-payloads-exporter-health)
- <a id="exported-spans" />[Exported spans](/gateway/opentelemetry/spans-and-events#exported-spans)
- <a id="diagnostic-event-catalog" />[Diagnostic event catalog](/gateway/opentelemetry/spans-and-events#diagnostic-event-catalog)
- <a id="without-an-exporter" />[Without an exporter](/gateway/opentelemetry/setup#without-an-exporter)
- <a id="disable" />[Disable](/gateway/opentelemetry/setup#disable)

## Related

- [Logging](/logging) - file logs, console output, CLI tailing, and the Control UI Logs tab
- [Gateway logging internals](/gateway/logging) - WS log styles, subsystem prefixes, and console capture
- [Diagnostics flags](/diagnostics/flags) - targeted debug-log flags
- [Diagnostics export](/gateway/diagnostics) - operator support-bundle tool (separate from OTEL export)
- [Configuration reference](/gateway/config-observability#diagnostics) - full `diagnostics.*` field reference
