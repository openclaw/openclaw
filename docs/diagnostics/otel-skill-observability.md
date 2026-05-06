# OpenTelemetry Skill Observability

Use this guide to inspect OpenClaw skill execution traces and metrics in Jaeger and Prometheus.

## Skill lifecycle coverage

OpenClaw now emits `skill.execution.*` diagnostics events for three skill stages per run:

- `skills.entries.resolve`
- `skills.env.apply`
- `skills.prompt.build`

Each stage emits:

- `skill.execution.started`
- `skill.execution.completed`
- `skill.execution.error`

The diagnostics-otel plugin exports these events as:

- span: `openclaw.skill.execution`
- histogram: `openclaw.skill.execution.duration_ms`
- histogram: `openclaw.skill.loaded_count`
- counter: `openclaw.skill.execution.total`

Useful span attributes:

- `openclaw.skill.name`
- `openclaw.skill.phase`
- `openclaw.skill.scope`
- `openclaw.outcome`
- `openclaw.errorCategory`

## Jaeger workflow

1. Filter by service name (`openclaw` by default or your configured `otel.serviceName`).
2. Search operation `openclaw.run` and open a slow trace.
3. Expand children and locate `openclaw.skill.execution`.
4. Compare phase durations by filtering span attributes:
   - `openclaw.skill.phase=entries`
   - `openclaw.skill.phase=env`
   - `openclaw.skill.phase=prompt`
5. For failures, filter `openclaw.outcome=error` and inspect `openclaw.errorCategory`.

## Prometheus queries

P95 skill duration by phase:

```promql
histogram_quantile(
  0.95,
  sum by (le, openclaw_skill_phase) (
    rate(openclaw_skill_execution_duration_ms_bucket[5m])
  )
)
```

Skill error rate by phase:

```promql
sum by (openclaw_skill_phase) (
  rate(openclaw_skill_execution_total{openclaw_outcome="error"}[5m])
)
/
sum by (openclaw_skill_phase) (
  rate(openclaw_skill_execution_total{openclaw_outcome=~"completed|error"}[5m])
)
```

Skill loaded count P95 by phase:

```promql
histogram_quantile(
  0.95,
  sum by (le, openclaw_skill_phase) (
    rate(openclaw_skill_loaded_count_bucket[5m])
  )
)
```

Top failing skill names:

```promql
topk(
  10,
  sum by (openclaw_skill_name) (
    rate(openclaw_skill_execution_total{openclaw_outcome="error"}[10m])
  )
)
```

## Configuration checklist

- Set `diagnostics.enabled: true`.
- Set `diagnostics.otel.enabled: true`.
- Enable traces and metrics.
- Use `diagnostics.otel.sampleRate: 1` during debugging.
- Confirm exporter endpoints for traces and metrics are reachable.
