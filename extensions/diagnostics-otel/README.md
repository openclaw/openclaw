# @openclaw/diagnostics-otel

Official OpenTelemetry diagnostics exporter for OpenClaw.

<<<<<<< HEAD
This plugin exports OpenClaw Gateway traces, metrics, and logs to an OTLP collector for observability stacks such as Grafana, Datadog, Honeycomb, New Relic, Tempo, and compatible collectors. It can also write diagnostic log records as stdout JSONL for container log pipelines.
=======
This plugin exports OpenClaw Gateway traces, metrics, and logs to an OTLP collector for observability stacks such as Grafana, Datadog, Honeycomb, New Relic, Tempo, and compatible collectors.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

## Install

```bash
openclaw plugins install @openclaw/diagnostics-otel
```

Restart the Gateway after installing or updating the plugin.

## Configure

Enable the plugin and set the OTLP endpoint in `plugins.entries.diagnostics-otel.config`.

The full config surface, metric names, span names, and collector examples live in the docs:

- https://docs.openclaw.ai/gateway/opentelemetry

## Package

- Plugin id: `diagnostics-otel`
- Package: `@openclaw/diagnostics-otel`
- Minimum OpenClaw host: `2026.4.25`
