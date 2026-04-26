---
summary: "Expose OpenClaw diagnostics as Prometheus text metrics through the diagnostics-prometheus plugin"
title: "Prometheus metrics"
read_when:
  - You want Prometheus, Grafana, VictoriaMetrics, or another scraper to collect OpenClaw Gateway metrics
  - You need the Prometheus metric names and label policy for dashboards or alerts
  - You want metrics without running an OpenTelemetry collector
---

OpenClaw can expose diagnostics metrics through the bundled
`diagnostics-prometheus` plugin. It listens to trusted internal diagnostics and
renders a Prometheus text endpoint at:

```text
/api/diagnostics/prometheus
```

The route uses Gateway authentication. Do not expose it as a public
unauthenticated `/metrics` endpoint.

## Quick start

```json5
{
  plugins: {
    allow: ["diagnostics-prometheus"],
    entries: {
      "diagnostics-prometheus": { enabled: true },
    },
  },
  diagnostics: {
    enabled: true,
  },
}
```

You can also enable the plugin from the CLI:

```bash
openclaw plugins enable diagnostics-prometheus
```

Then scrape the protected Gateway route with the same Gateway authentication you
use for operator APIs.

## Metrics exported

| Metric                                        | Type      | Labels                                                                                    |
| --------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `openclaw_run_completed_total`                | counter   | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_run_duration_seconds`               | histogram | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_model_call_total`                   | counter   | `api`, `error_category`, `model`, `outcome`, `provider`, `transport`                      |
| `openclaw_model_call_duration_seconds`        | histogram | `api`, `error_category`, `model`, `outcome`, `provider`, `transport`                      |
| `openclaw_model_tokens_total`                 | counter   | `agent`, `channel`, `model`, `provider`, `token_type`                                     |
| `openclaw_gen_ai_client_token_usage`          | histogram | `model`, `provider`, `token_type`                                                         |
| `openclaw_model_cost_usd_total`               | counter   | `agent`, `channel`, `model`, `provider`                                                   |
| `openclaw_tool_execution_total`               | counter   | `error_category`, `outcome`, `params_kind`, `tool`                                        |
| `openclaw_tool_execution_duration_seconds`    | histogram | `error_category`, `outcome`, `params_kind`, `tool`                                        |
| `openclaw_harness_run_total`                  | counter   | `channel`, `error_category`, `harness`, `model`, `outcome`, `phase`, `plugin`, `provider` |
| `openclaw_harness_run_duration_seconds`       | histogram | `channel`, `error_category`, `harness`, `model`, `outcome`, `phase`, `plugin`, `provider` |
| `openclaw_message_processed_total`            | counter   | `channel`, `outcome`, `reason`                                                            |
| `openclaw_message_processed_duration_seconds` | histogram | `channel`, `outcome`, `reason`                                                            |
| `openclaw_message_delivery_total`             | counter   | `channel`, `delivery_kind`, `error_category`, `outcome`                                   |
| `openclaw_message_delivery_duration_seconds`  | histogram | `channel`, `delivery_kind`, `error_category`, `outcome`                                   |
| `openclaw_queue_lane_size`                    | gauge     | `lane`                                                                                    |
| `openclaw_queue_lane_wait_seconds`            | histogram | `lane`                                                                                    |
| `openclaw_session_state_total`                | counter   | `reason`, `state`                                                                         |
| `openclaw_session_queue_depth`                | gauge     | `state`                                                                                   |
| `openclaw_memory_bytes`                       | gauge     | `kind`                                                                                    |
| `openclaw_memory_rss_bytes`                   | histogram | none                                                                                      |
| `openclaw_memory_pressure_total`              | counter   | `level`, `reason`                                                                         |
| `openclaw_telemetry_exporter_total`           | counter   | `exporter`, `reason`, `signal`, `status`                                                  |
| `openclaw_prometheus_series_dropped_total`    | counter   | none                                                                                      |

## Label policy

Prometheus labels stay bounded and low-cardinality. The exporter does not emit
raw diagnostic identifiers such as `runId`, `sessionKey`, `sessionId`, `callId`,
`toolCallId`, message IDs, chat IDs, or provider request IDs.

Label values are redacted and must match OpenClaw's low-cardinality character
policy. Values that fail the policy are replaced with `unknown`, `other`, or
`none`, depending on the metric.

The exporter caps retained time series in memory. If the cap is reached, new
series are dropped and `openclaw_prometheus_series_dropped_total` increments.

For full traces, logs, OTLP export, and OpenTelemetry GenAI semantic attributes,
use [OpenTelemetry export](/gateway/opentelemetry).
