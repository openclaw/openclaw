# OpenClaw Octopus Orchestrator — Observability

## Status
Milestone 0 draft. Concrete metric catalog, log fields, and operator views. Referenced by LLD §Observability.

## Principles
1. Everything important is in the event log. Metrics are derived views.
2. Metric names use `openclaw_octo_*` prefix to avoid collision with existing OpenClaw metrics.
3. Labels identify the entity (arm_id, node_id, mission_id); they do not carry high-cardinality values like individual grip ids.
4. Structured events (for debugging) and numeric metrics (for alerting) are kept distinct — never try to alert on an event stream.

## Metric catalog

### Arm metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_arms_active` | gauge | `node_id`, `agent_id`, `adapter_type` | Currently active arms |
| `openclaw_octo_arms_idle` | gauge | `node_id`, `agent_id` | Idle arms holding resources |
| `openclaw_octo_arms_quarantined` | gauge | `node_id`, `agent_id` | Quarantined arms awaiting intervention |
| `openclaw_octo_arm_restarts_total` | counter | `adapter_type`, `reason` | Cumulative arm restarts by reason |
| `openclaw_octo_arm_spawn_duration_seconds` | histogram | `adapter_type` | Time from spawn request to `arm.active` |
| `openclaw_octo_arm_progress_stall_total` | counter | `adapter_type` | Arms that hit the stall threshold |
| `openclaw_octo_arm_output_bytes_total` | counter | `adapter_type` | Normalized output bytes emitted |
| `openclaw_octo_arm_output_dropped_total` | counter | `adapter_type`, `reason` | Backpressure drops |

### Grip metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_grips_queued` | gauge | `mission_id_bucket` | Grips waiting for placement |
| `openclaw_octo_grips_running` | gauge | `mission_id_bucket` | Grips currently assigned |
| `openclaw_octo_grips_blocked` | gauge | `mission_id_bucket` | Grips blocked on claims or dependencies |
| `openclaw_octo_grip_latency_seconds` | histogram | `type` | Wall clock time from `grip.created` to terminal state |
| `openclaw_octo_grip_retries_total` | counter | `type`, `classification` | Retry attempts by failure class |
| `openclaw_octo_grip_ambiguous_total` | counter | — | Suspected duplicate executions |

`mission_id_bucket` is a low-cardinality bucket (`small`, `medium`, `large`) derived from mission size, not raw mission ids.

### Scheduler metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_scheduler_decisions_total` | counter | `decision` | Placement decisions: `placed`, `deferred`, `rejected` |
| `openclaw_octo_scheduler_score` | histogram | — | Distribution of winning placement scores |
| `openclaw_octo_scheduler_cycle_duration_seconds` | histogram | — | Time to run one scheduling cycle |
| `openclaw_octo_scheduler_fairness_skew` | gauge | — | Max virtual-time spread across active missions |

### Node metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_node_up` | gauge | `node_id`, `agent_id` | 1 if lease is healthy, 0 if degraded |
| `openclaw_octo_node_arm_capacity` | gauge | `node_id` | `max_arms - current_arms` |
| `openclaw_octo_node_lease_renewals_total` | counter | `node_id` | Successful lease renewals |
| `openclaw_octo_node_lease_misses_total` | counter | `node_id`, `reason` | Missed renewals by reason |
| `openclaw_octo_node_reconcile_anomalies_total` | counter | `node_id`, `kind` | SessionReconciler anomalies |

### Event log metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_events_written_total` | counter | `entity_type`, `event_type` | Events appended |
| `openclaw_octo_event_log_bytes` | gauge | — | Active log size |
| `openclaw_octo_event_replay_duration_seconds` | histogram | — | Time to replay log on restart |
| `openclaw_octo_event_archive_rotations_total` | counter | — | Archive rotations performed |

### Cost metrics
| Metric | Type | Labels | Description |
|---|---|---|---|
| `openclaw_octo_tokens_total` | counter | `provider`, `model`, `kind` | Tokens by kind: `input`, `output`, `cache_hit` |
| `openclaw_octo_cost_usd_total` | counter | `provider`, `model` | Dollar cost accumulated |
| `openclaw_octo_mission_budget_used_ratio` | gauge | — | Fraction of mission budget consumed; 0..1+ |
| `openclaw_octo_mission_budget_exceeded_total` | counter | `action` | Budget enforcement actions: `pause`, `abort`, `warn_only` |

## Log fields
Every Octopus log line carries these structured fields at minimum:
- `subsystem` (always `"octo"`)
- `component` (`"head"`, `"node-agent"`, `"adapter.<type>"`, `"cli"`)
- `node_id` (when applicable)
- `arm_id`, `mission_id`, `grip_id` (when applicable)
- `event_id` (when triggered by a specific event)
- `actor` (operator device id or `"system"`)
- `level`, `ts`, `message`

Secret redaction is applied before serialization via the existing OpenClaw redaction hooks.

## Operator views

### `openclaw octo status`
Human default: a single-screen dashboard showing active arms, queued grips, healthy nodes, mission count, budget state.
`--json` output: structured snapshot suitable for machine consumption.

### `openclaw octo events --tail`
Live stream of the event log, filterable by `--entity`, `--type`, `--mission`.

### `openclaw octo audit --since <time>`
Operator action history for compliance and post-incident review.

## Alert targets (for future dashboarding)

These are the signals the eventual dashboard and on-call runbook should be built around. No alerting infrastructure is built in the MVP — this catalog just names the signals so instrumentation is consistent from day one.

| Alert | Signal |
|---|---|
| Node degraded | `openclaw_octo_node_up == 0` for N minutes |
| Scheduler stuck | `openclaw_octo_scheduler_cycle_duration_seconds` p95 > threshold |
| Ambiguous duplicates spiking | `rate(openclaw_octo_grip_ambiguous_total) > 0` |
| Event log write backlog | `openclaw_octo_arm_output_dropped_total` non-zero |
| Budget breach | `openclaw_octo_mission_budget_exceeded_total` non-zero |
| Replay failing | `openclaw_octo_event_replay_duration_seconds` unusually high or replay returns error |

## Related
- LLD §Observability, §Backpressure, §Cost Accounting
- TEST-STRATEGY.md (which metrics the chaos tests assert on)
