---
summary: "Expose OpenClaw diagnostics as Prometheus text metrics through the diagnostics-prometheus plugin"
title: "Prometheus metrics"
sidebarTitle: "Prometheus"
read_when:
  - You want Prometheus, Grafana, VictoriaMetrics, or another scraper to collect OpenClaw Gateway metrics
  - You need the Prometheus metric names and label policy for dashboards or alerts
  - You want metrics without running an OpenTelemetry collector
---

OpenClaw can expose diagnostics metrics through the official
`diagnostics-prometheus` plugin. It listens to trusted diagnostics plus
internally tagged, dispatcher-owned diagnostic events (queue, memory, and
session-recovery signals), and renders a Prometheus text endpoint at:

```text
GET /api/diagnostics/prometheus
```

Content type is `text/plain; version=0.0.4; charset=utf-8`, the standard
Prometheus exposition format.

<Warning>
The route uses Gateway authentication (operator scope, trusted-operator surface) and requires the caller's effective scopes to include `operator.read` (implied by `operator.write` or `operator.admin`). Do not expose it as a public unauthenticated `/metrics` endpoint. Scrape it through the same auth path you use for other operator APIs.
</Warning>

For traces, logs, OTLP push, and OpenTelemetry GenAI semantic attributes, see [OpenTelemetry export](/gateway/opentelemetry).

## Quick start

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install clawhub:@openclaw/diagnostics-prometheus
    ```
  </Step>
  <Step title="Enable the plugin">
    <Tabs>
      <Tab title="Config">
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
      </Tab>
      <Tab title="CLI">
        ```bash
        openclaw plugins enable diagnostics-prometheus
        ```
      </Tab>
    </Tabs>
  </Step>
  <Step title="Restart the Gateway">
    The HTTP route is registered at plugin startup, so reload after enabling.

    ```bash
    openclaw gateway restart
    ```

  </Step>
  <Step title="Scrape the protected route">
    Send the same gateway auth your operator clients use:

    ```bash
    curl -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
      http://127.0.0.1:18789/api/diagnostics/prometheus
    ```

  </Step>
  <Step title="Wire Prometheus">
    ```yaml
    # prometheus.yml
    scrape_configs:
      - job_name: openclaw
        scrape_interval: 30s
        metrics_path: /api/diagnostics/prometheus
        authorization:
          credentials_file: /etc/prometheus/openclaw-gateway-token
        static_configs:
          - targets: ["openclaw-gateway:18789"]
    ```
  </Step>
</Steps>

<Note>
`diagnostics.enabled` defaults to `true`; set it to `false` only in tightly constrained environments. When it is `false` at exporter startup, the plugin still registers the HTTP route, but no diagnostic events or runtime identity are recorded, so the response is empty.
</Note>

## Metrics exported

| Metric                                                    | Type      | Labels                                                                                    |
| --------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `openclaw_gateway_build_info`                             | gauge     | `process_instance_id`, optional `build_id`                                                |
| `openclaw_gc_duration_seconds`                            | histogram | none                                                                                      |
| `openclaw_gateway_rpc_requests_total`                     | counter   | `method`                                                                                  |
| `openclaw_gateway_rpc_first_response_seconds`             | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_response_bytes`                     | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_handler_heap_delta_bytes`           | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_handler_heap_delta_exclusive_total` | counter   | `method`                                                                                  |
| `openclaw_gateway_rpc_handler_seconds`                    | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_admission_seconds`                  | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_queue_wait_seconds`                 | histogram | `method`                                                                                  |
| `openclaw_chat_send_phase_seconds`                        | histogram | `phase`, `stage` (`request` or `startup`)                                                 |
| `openclaw_gateway_rpc_stage_seconds`                      | histogram | `method`, `phase`                                                                         |
| `openclaw_gateway_rpc_stage_thread_cpu_seconds`           | histogram | `method`, `phase`                                                                         |
| `openclaw_worktree_preparation_seconds`                   | histogram | `kind`, `template`, `outcome`, `phase`                                                    |
| `openclaw_gateway_rpc_outcomes_total`                     | counter   | `phase`, `outcome`                                                                        |
| `openclaw_run_completed_total`                            | counter   | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_run_duration_seconds`                           | histogram | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_model_call_total`                               | counter   | `api`, `error_category`, `model`, `observation_unit`, `outcome`, `provider`, `transport`  |
| `openclaw_model_call_duration_seconds`                    | histogram | `api`, `error_category`, `model`, `observation_unit`, `outcome`, `provider`, `transport`  |
| `openclaw_model_failover_total`                           | counter   | `from_model`, `from_provider`, `lane`, `reason`, `suspended`, `to_model`, `to_provider`   |
| `openclaw_model_tokens_total`                             | counter   | `agent`, `channel`, `model`, `provider`, `token_type`                                     |
| `openclaw_gen_ai_client_token_usage`                      | histogram | `model`, `provider`, `token_type`                                                         |
| `openclaw_model_cost_usd_total`                           | counter   | `agent`, `channel`, `model`, `provider`                                                   |
| `openclaw_model_usage_duration_seconds`                   | histogram | `agent`, `channel`, `model`, `provider`                                                   |
| `openclaw_skill_used_total`                               | counter   | `activation`, `agent`, `skill`, `source`                                                  |
| `openclaw_tool_execution_total`                           | counter   | `error_category`, `outcome`, `params_kind`, `tool`, `tool_owner`, `tool_source`           |
| `openclaw_tool_execution_duration_seconds`                | histogram | `error_category`, `outcome`, `params_kind`, `tool`, `tool_owner`, `tool_source`           |
| `openclaw_tool_execution_blocked_total`                   | counter   | `denied_reason`, `params_kind`, `tool`, `tool_owner`, `tool_source`                       |
| `openclaw_harness_run_total`                              | counter   | `channel`, `error_category`, `harness`, `model`, `outcome`, `phase`, `plugin`, `provider` |
| `openclaw_harness_run_duration_seconds`                   | histogram | `channel`, `error_category`, `harness`, `model`, `outcome`, `phase`, `plugin`, `provider` |
| `openclaw_webhook_received_total`                         | counter   | `channel`, `webhook`                                                                      |
| `openclaw_webhook_error_total`                            | counter   | `channel`, `webhook`                                                                      |
| `openclaw_webhook_duration_seconds`                       | histogram | `channel`, `webhook`                                                                      |
| `openclaw_message_received_total`                         | counter   | `channel`, `source`                                                                       |
| `openclaw_message_dispatch_started_total`                 | counter   | `channel`, `source`                                                                       |
| `openclaw_message_dispatch_completed_total`               | counter   | `channel`, `outcome`, `reason`, `source`                                                  |
| `openclaw_message_dispatch_duration_seconds`              | histogram | `channel`, `outcome`, `reason`, `source`                                                  |
| `openclaw_message_processed_total`                        | counter   | `channel`, `outcome`, `reason`                                                            |
| `openclaw_message_processed_duration_seconds`             | histogram | `channel`, `outcome`, `reason`                                                            |
| `openclaw_message_delivery_started_total`                 | counter   | `channel`, `delivery_kind`                                                                |
| `openclaw_message_delivery_total`                         | counter   | `channel`, `delivery_kind`, `error_category`, `outcome`                                   |
| `openclaw_message_delivery_duration_seconds`              | histogram | `channel`, `delivery_kind`, `error_category`, `outcome`                                   |
| `openclaw_talk_event_total`                               | counter   | `brain`, `event_type`, `mode`, `provider`, `transport`                                    |
| `openclaw_talk_event_duration_seconds`                    | histogram | `brain`, `event_type`, `mode`, `provider`, `transport`                                    |
| `openclaw_talk_audio_bytes`                               | histogram | `brain`, `event_type`, `mode`, `provider`, `transport`                                    |
| `openclaw_queue_lane_size`                                | gauge     | `lane`                                                                                    |
| `openclaw_queue_lane_wait_seconds`                        | histogram | `lane`                                                                                    |
| `openclaw_session_state_total`                            | counter   | `reason`, `state`                                                                         |
| `openclaw_session_queue_depth`                            | gauge     | `state`                                                                                   |
| `openclaw_session_turn_created_total`                     | counter   | `agent`, `channel`, `trigger`                                                             |
| `openclaw_session_stuck_total`                            | counter   | `reason`, `state`                                                                         |
| `openclaw_session_stuck_age_seconds`                      | histogram | `reason`, `state`                                                                         |
| `openclaw_session_recovery_total`                         | counter   | `action`, `active_work_kind`, `state`, `status`                                           |
| `openclaw_session_recovery_age_seconds`                   | histogram | `action`, `active_work_kind`, `state`, `status`                                           |
| `openclaw_gateway_event_loop_delay_max_seconds`           | histogram | none                                                                                      |
| `openclaw_gateway_event_loop_observed_seconds_total`      | counter   | none                                                                                      |
| `openclaw_liveness_warning_total`                         | counter   | `reason`                                                                                  |
| `openclaw_liveness_sessions`                              | gauge     | `state`                                                                                   |
| `openclaw_liveness_event_loop_delay_p99_seconds`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_event_loop_delay_max_seconds`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_event_loop_utilization_ratio`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_cpu_core_ratio`                        | histogram | `reason`                                                                                  |
| `openclaw_payload_large_total`                            | counter   | `action`, `channel`, `plugin`, `reason`, `surface`                                        |
| `openclaw_payload_large_bytes`                            | histogram | `action`, `channel`, `plugin`, `reason`, `surface`                                        |
| `openclaw_memory_bytes`                                   | gauge     | `kind`                                                                                    |
| `openclaw_heap_space_bytes`                               | gauge     | `space`, `stat`                                                                           |
| `openclaw_worker_count`                                   | gauge     | none                                                                                      |
| `openclaw_worker_queue_depth`                             | gauge     | `kind`                                                                                    |
| `openclaw_worker_queue_wait_seconds`                      | histogram | `kind`, `request_class`                                                                   |
| `openclaw_worker_request_seconds`                         | histogram | `kind`, `request_class`                                                                   |
| `openclaw_worker_heap_sampled_count`                      | gauge     | none                                                                                      |
| `openclaw_worker_heap_used_bytes`                         | gauge     | `script`                                                                                  |
| `openclaw_worker_started_total`                           | counter   | `script`                                                                                  |
| `openclaw_worker_retired_total`                           | counter   | `script`, `reason`                                                                        |
| `openclaw_child_process_spawn_total`                      | counter   | `family`, `operation`                                                                     |
| `openclaw_memory_rss_bytes`                               | histogram | none                                                                                      |
| `openclaw_memory_pressure_total`                          | counter   | `level`, `reason`                                                                         |
| `openclaw_telemetry_exporter_total`                       | counter   | `exporter`, `reason`, `signal`, `status`                                                  |
| `openclaw_prometheus_series_dropped_total`                | counter   | none                                                                                      |
| `openclaw_diagnostic_async_queue_dropped_total`           | counter   | `drop_class`                                                                              |
| `openclaw_diagnostic_async_queue_length`                  | gauge     | none                                                                                      |

For model-call metrics, `observation_unit="request"` measures one observable
provider request. `observation_unit="turn"` measures a synthetic Claude Code
or Codex CLI agent turn that can contain multiple hidden provider requests.
Keep those series separate when comparing latency.

Gateway RPC metrics cover valid authenticated WebSocket requests, including
subsequent rejections. `first_response` measures receipt through the first frame
accepted by the sender; unavailable or suppressed sends have no duration sample.
`handler` measures actual handler invocation through return or throw, and
`admission` measures receipt through that invocation. `queue_wait` measures only
operator request start-queue wait, separately from command/session lane metrics.
They measure elapsed time, not CPU time. Early acknowledgments and responses
after handler return are distinct from completed agent work. See
[Gateway RPC timing semantics](/gateway/opentelemetry#gateway-rpc).

Receipt begins after the connected client's request frame passes validation.
These timings exclude CLI startup, local diagnostics, connection/authentication
setup, and event-loop delay before request dispatch. Histograms record completed
observations: an unfinished handler has no handler-duration sample yet. Compare
request counts, completed timings, and event-loop observations when investigating
a timeout; low handler latency alone does not establish a responsive client path.

RPC method labels contain exact core and registered plugin method names, `other`
for unregistered requests, or `unknown` for unrecognized dedicated worker RPCs.
Catalog membership is checked at request receipt, so plugin registry replacement
affects subsequent requests without a separate label cache.
Outcome totals aggregate by phase and outcome without a
method dimension. Each method with all four timings, both byte histograms, and the exclusive-sample counter occupies eight aggregate
samples in the shared 2,048-sample cap. A duration histogram occupies one sample
but expands into 19 scrape series (buckets, sum, and count). The response-size
and signed heap-delta histograms expand into 20 and 38 series respectively; see
[RPC response size and heap changes](/gateway/diagnostics#rpc-response-size-and-heap-changes). Existing samples keep
updating when the cap fills; unseen RPC or other operational samples are refused
and increment `openclaw_prometheus_series_dropped_total`. Monitor that counter:
coverage of every core method can fill the cap, so a zero value matters when
interpreting totals or latency percentiles. Async diagnostic queue saturation can
also drop observations, reported by `openclaw_diagnostic_async_queue_dropped_total`.

### Worktree preparation

`openclaw_worktree_preparation_seconds` records each managed checkout or sandbox
preparation, including failures. `kind` distinguishes `managed` creation from
`sandbox` projection and backend readiness. `template` distinguishes `warm`,
`cold`, `unavailable`, and `reused` existing projections; `outcome` is `returned`
or `threw`. `phase=total` is the complete elapsed time. Other fixed phases are
`allocate`, `checkout`, `setup`, `templatePrepare`, `templateApply`, `snapshot`,
`synchronizeCanonical`, `synchronizeProjection`, `workspaceLayout`, and
`containerStart`. Only entered phases are recorded. Nested phases are inclusive
and must not be summed. No paths, session identifiers, or template keys become
metric labels.

### Catalog list stages

The stage histograms currently cover only `sessions.catalog.list`. They use
six fixed phase labels:

| Phase                | Observation                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `projection_initial` | Initial shared projection readiness, when the request must await it                  |
| `planning`           | Synchronous creation and freezing of the leader's provider-planning snapshot         |
| `provider`           | Leader enumeration, including provider admission, awaited source work and completion |
| `coalesced`          | A follower awaiting the existing enumeration for the same caller and request         |
| `projection_final`   | Shared projection readiness required after enumeration                               |
| `delivery`           | Synchronous final projection, visibility filtering and response callback             |

Each entered phase contributes one completed elapsed observation, including when
that phase throws. Unvisited phases are absent. Metadata-only requests do not
enter these phases. Provider and projection durations include awaited work and
scheduling; they are not CPU time or exclusive ownership of shared work.

The thread-CPU histogram records only `planning` and `delivery`. Its intervals
never cross an await and finish before telemetry emission. They include
same-thread native work and garbage collection, but exclude worker CPU,
background materialization and progress publications. They are selected CPU
intervals, not a complete request CPU total. If a CPU counter read fails, that
CPU observation is omitted while elapsed timing and the request outcome remain
available. Compare each metric's own count when computing means.

These trusted, payload-free observations use the existing bounded diagnostic
queue and exporter endpoint whenever diagnostics and an interested trusted
consumer are active. They have no slow-log threshold and add no request, session,
provider or host labels. The six elapsed and two CPU populations consume at most
eight aggregate samples, or 152 exposed histogram series, under the existing
2,048-sample cap. Startup-phase emission and its whole-process CPU semantics are
unchanged.

An OpenTelemetry exporter with traces disabled does not request phase events.
A configured Prometheus exporter records these observations as metrics without
requiring OpenTelemetry traces.

### Runtime identity

`openclaw_gateway_build_info` has value `1` and identifies the process serving
the scrape. Its `process_instance_id` is the same process-owned UUID returned by
`system.info`; it changes when the process restarts, including when a PID is
reused. `build_id` matches the loaded build reported by `hello.server.buildId`
and is omitted when that provenance is unavailable. Updating files on disk does
not change the running process's identity.

When diagnostics are enabled, the exporter captures these facts at service startup,
before recording events.
The metric uses one aggregate sample under the existing cap. Older hosts without
the optional runtime-identity capability omit it. The UUID is confined to this
info metric; it is not added to RPC or other metric labels.

Use the info sample from the same scrape to attribute new measurements and split
counter intervals at process changes. It is not a health signal, a request ID,
or an exporter epoch: restarting the exporter in the same process resets its
counters while retaining the process identity. It cannot relabel older samples
or establish complete diagnostic-loss coverage.

### Event-loop observation windows

`openclaw_liveness_cpu_core_ratio` measures whole-process CPU usage in core
equivalents, including worker and native threads, and can exceed `1`. Interpret
it alongside main-thread delay and utilization; see
[CPU pressure and event-loop delay](/gateway/health#cpu-pressure-and-event-loop-delay).

The event-loop histogram records the maximum delay from each completed Gateway
health-monitor window. The counter sums the seconds represented by those
windows. Both are cumulative: a later healthy window does not erase an earlier
high-delay observation. Readiness, status, and scrape requests consume completed
observations without advancing or resetting the sampling window.

The monitor samples elapsed event-loop intervals every 20 milliseconds and
completes a window after at least one second, or sooner for a delay warning.
It preserves the pending interval across ordinary window resets, so reading
health before an overdue sample cannot erase that delay. Histogram counts are window counts, not stall
counts. Histogram quantiles describe window maxima, not the sampled event-loop
delay distribution or its overall p99. These metrics have no request labels or
trace attribution and do not identify the JavaScript function that blocked.

Collection uses the plugin enablement above. It starts when an interested
metrics exporter is running; it does not backfill earlier windows. Intentional
monitor resets discard the unfinished window. Diagnostic queue drops, the
exporter's series cap, and process restarts can also lose observations. Watch
the existing drop counters and the represented-duration counter when assessing
coverage. Readiness decisions and persistent liveness-warning thresholds are unchanged.

### Worker request queues

`openclaw_worker_queue_depth{kind}` reports requests awaiting dispatch across
worker owners of that kind. It includes SQLite writer capacity waiters and scoped
read-only requests, and excludes requests that already hold an execution slot.
`openclaw_worker_queue_wait_seconds{kind,request_class}` measures enqueue to
dispatch; `openclaw_worker_request_seconds{kind,request_class}` measures dispatch
to reply or failure. Both use the existing duration histogram buckets. Cancellation
before dispatch removes the queued request without adding a duration sample.

Task kinds use their registered runtime entrypoint names, such as `gitOperations`,
`preparedModelCatalog`, `codeModeNode`, and `sessionTranscript`. Standalone bundled
workers have fixed names such as `diskBudget`, `memorySearch`, and `teamReports`.
Unrecognized SDK worker filenames use `extension`; arbitrary filenames and paths never become
labels. This replaces the broad `compute` and `other` task buckets and renames
previous grouped task kinds, so update queries that select those older labels.

SQLite transport kinds remain `sqlite_read` and `sqlite_writer`. Request classes
retain `open`, `close`, `transcript_read`, `sessions`, `transcripts`,
`domain_execute`, `plugin_state`, `auth_profiles`, and `cron`. Other commands use a
fixed operation family, such as `workerInference`, `capture`, or `diagnostic`.
Audit writer, database lifecycle, and state lease commands have finer labels such
as `audit.writer.process`, `database.inspectIdle`, and `stateLease.renew`.
Unknown commands retain `execute`; unknown request classes become `other`.
The allowlists bound cardinality without publishing session IDs, database paths,
command suffixes, or caller-provided names. The exporter's shared series cap still
applies.

The `transcripts` request family includes canonical event appends and retention.

Shared-state reads use kind `stateRead` (formerly `state_read`) and the same
bounded operation-family classifier as SQLite writers. Examples include
`devicePairing`, `acpSessions`, `workers`, and `cron`; standalone admission reads
use `admit`. The read owner supplies the operation before queue admission, so
queue wait and execution use the same class without labeling request payloads.

Dispatch is the host scheduler's allocation of a slot, not a worker-side CPU
timestamp. Request duration includes preparation, cold worker startup, transport,
host exchanges, and I/O. General task pools report `task`; SQLite commands retain
their bounded operation family. These metrics do not separate individual pools
for the same worker entrypoint, and unscoped one-shot inspection subprocesses are
outside the queue gauge. Identity and avatar pools share compute admission with other compute pools;
their queue wait does not by itself prove their own worker limit is too small.

Observations use the existing asynchronous diagnostic queue and begin when a
consumer subscribes. Queue drops can lose samples or leave a gauge at its last
delivered value until another request updates it. Check
`openclaw_diagnostic_async_queue_dropped_total` before interpreting a saturated
interval. No worker limits, scheduling order, or cancellation behavior change.

```promql
# Worker wait p99, by kind and bounded request family
histogram_quantile(0.99,
  sum by (le, kind, request_class) (rate(openclaw_worker_queue_wait_seconds_bucket[5m])))

# Request classes occupying dispatch slots for the most wall time
sum by (kind, request_class) (rate(openclaw_worker_request_seconds_sum[5m]))

# Shared-state read rate, by operation family
sum by (request_class) (rate(openclaw_worker_request_seconds_count{kind="stateRead"}[5m]))
```

### Memory and process churn

`openclaw_memory_bytes` exposes `rss`, `heap_total`, `heap_used`, `external`,
`array_buffers`, `worker_heap_total`, and `worker_heap_used`. RSS covers the
whole process. The unprefixed heap and native-buffer values cover the main
isolate; `array_buffers` is included in `external`, so do not add them together.
These values do not account for every native allocation or allocator arena.

Worker totals sum completed native heap samples from live Workers created after
the resource registry starts. On Node, this includes direct plugin Workers;
nested Workers, native-library thread pools (such as Discord DAVE's Rayon pool),
and V8's internal threads are outside the parent registry.
The 30-second diagnostics heartbeat starts a nonblocking refresh, retaining at
most one outstanding request per Worker. Samples expire after 60 seconds and
are removed when the Worker exits. Compare `openclaw_worker_heap_sampled_count`
with `openclaw_worker_count`: startup, unavailable APIs, and stalled Workers can
produce partial totals. No heap snapshot or extra sampling timer is created.
`openclaw_worker_heap_used_bytes{script="..."}` sums fresh heap samples for each
Worker script. Labels use a fixed allowlist of runtime-entrypoint, pooled, and bundled plugin Worker basenames, normalized to
`.js` in source and packaged runs; unknown, eval, and unwrapped third-party Workers
use `other`. Full paths and eval source are never recorded. A script's series
disappears when it has no live, fresh samples. Memory-pressure logs include the
same byte counts and Worker coverage counts, plus `workerHeaps`: the five largest
individual fresh Worker heaps as `{script, heapUsed, heapTotal}` (bytes), using the same
bounded script names.

`openclaw_worker_started_total{script="..."}` and
`openclaw_worker_retired_total{script="...",reason="..."}` expose cumulative
starts and confirmed native exits through the same heartbeat. Retirement reasons
are `idle_timeout`, `memory_pressure`, `closed`, `rotation`, `cancelled`,
`failure`, or `exit` when an owner did not specify a reason. A retirement request
does not count until the Worker exits; failed termination and retries do not
double-count. Counters survive exporter restarts and reset with the process.
Use `60 * rate(openclaw_worker_started_total[5m])` for starts per minute by
script. These counts share the registry coverage limits above; they do not
measure resident memory released by an exit.

`openclaw gateway call diagnostics.lanes --json` also reports `workerCount`,
`workerPoolCount`, and `workerPools`. Each pool entry contains a process-local
`poolId`, an allowlisted `script`, and its live `workerCount`. The response lists
the 100 largest live pools; `workerPoolCount` includes all live pools. Counts
include pending retirements until native exit and disappear when a pool has no
live Workers. Direct Workers contribute to `workerCount` without a pool entry.
These are JavaScript Worker counts, not an operating-system thread census.

`openclaw_child_process_spawn_total{family="...",operation="..."}` counts successful launches
through OpenClaw's shared spawn and exec owners, including brokered launches.
Diagnostics must be enabled. The existing heartbeat publishes accumulated
counts after at least one minute, with debug logs reporting counts and rates
using the actual elapsed interval. Failed launches, direct calls bypassing
these owners, and descendants started by children are excluded. Families are
a fixed executable-name allowlist; unrecognized commands become `other`.
Git launches carry a bounded owner/operation label: `repository.identities`,
`repository.branches`, `checkout.revision`, `checkout.context`, `checkout.diff`,
`checkout.baseline`, `pull-request.branch-facts`, `worktree.snapshot`,
`worktree.cleanup`, `worktree.provision`, `worktree.inspect`,
`worktree.recovery`, `workspace.inventory`, `workspace.manifest`, `project.clone`,
`workspace.result-cleanup`, `session.materialize`, or `publication`. Worker operations retain their admitted
owner when the parent launches Git, including parallel batches and retries.
Unattributed Git launches use `unknown`; other executable families use `none`.
Arguments, repository paths, session IDs, and free-text caller names are never recorded.
For launches per minute grouped by Git owner, use
`60 * sum by (operation) (rate(openclaw_child_process_spawn_total{family="git"}[5m]))`.
To retain the previous per-family view, use
`60 * sum by (family) (rate(openclaw_child_process_spawn_total[5m]))`; this window accommodates
the minute-batched publication. Neither accounting path changes pressure
thresholds or user-tool execution.

`workspace.result-cleanup` identifies the post-start worker-placement orphan-ref
inventory. It examines at most eight checkout roots per full recovery sweep,
serially, and yields to active Gateway requests. The existing recovery scheduler
continues unfinished work; completed roots remain recorded only for that startup
cleanup pass. Normal result settlement still removes its own refs immediately.

### Garbage collection duration

`openclaw_gc_duration_seconds` records elapsed garbage collection (GC) duration
reported by Node.js for the hosting JavaScript isolate. Each observation is one
GC entry, not CPU time, allocated bytes, or a guaranteed stop-the-world pause.
Compare its bucket counts with event-loop window maxima to investigate GC as a
possible contributor to stalls; matching scrape intervals do not prove causality.

Collection uses the existing diagnostics enablement and starts when the
diagnostics heartbeat observes an interested consumer, such as a metrics exporter. A consumer added
after heartbeat startup may wait until the next 30-second tick, or longer if the
event loop is stalled. Entries preceding observer activation are not backfilled.
Demand is checked when entries are delivered, so a brief consumer gap before the
next heartbeat can still yield delayed observations. Losing the last
consumer suppresses new exports; the observer disconnects at the next heartbeat.
Disabling diagnostics or stopping the heartbeat disconnects it immediately.

The histogram is absent until the first observation, so absence does not prove
zero GC. Queue drops, the series cap, observation gaps and process restarts limit
coverage. Diagnostics disable/re-enable preserves the exporter's existing
counters; restarting the exporter resets them as usual. No extra timer, GC
trigger, trace attribution or application payload is collected.

## Label policy

<AccordionGroup>
  <Accordion title="Bounded, low-cardinality labels">
    Prometheus labels stay bounded and low-cardinality. The exporter does not emit raw diagnostic identifiers such as `runId`, `sessionKey`, `sessionId`, `callId`, `toolCallId`, message IDs, chat IDs, or provider request IDs.

    Label values are redacted and must match OpenClaw's low-cardinality character policy. Values that fail the policy are replaced with `unknown`, `other`, or `none`, depending on the metric. Labels that look like scoped agent session keys are also replaced with `unknown`.

  </Accordion>
  <Accordion title="Series cap and overflow accounting">
    The exporter caps retained time series in memory at **2048** series across counters, gauges, and histograms combined. New series beyond that cap are dropped, and `openclaw_prometheus_series_dropped_total` increments by one each time.

    Watch this counter as a hard signal that an attribute upstream is leaking high-cardinality values. The exporter never lifts the cap automatically; if it climbs, fix the source rather than disabling the cap.

  </Accordion>
  <Accordion title="What never appears in Prometheus output">
    - prompt text, response text, tool inputs, tool outputs, system prompts
    - Talk transcripts, audio payloads, call ids, room ids, handoff tokens, turn ids, and raw session ids
    - raw provider request IDs (only bounded hashes, where applicable, on spans — never on metrics)
    - session keys and session IDs
    - hostnames, file paths, secret values

  </Accordion>
</AccordionGroup>

## PromQL recipes

```promql
# Gateway RPC requests per second by method
sum by (method) (rate(openclaw_gateway_rpc_requests_total[5m]))

# 95th percentile first-response latency by method
histogram_quantile(
  0.95,
  sum by (le, method) (rate(openclaw_gateway_rpc_first_response_seconds_bucket[5m]))
)

# 95th percentile operator request start-queue wait by method
histogram_quantile(
  0.95,
  sum by (le, method) (rate(openclaw_gateway_rpc_queue_wait_seconds_bucket[5m]))
)

# Tokens per second, split by provider
sum by (provider) (rate(openclaw_model_tokens_total[1m]))

# Spend (USD) over the last hour, by model
sum by (model) (increase(openclaw_model_cost_usd_total[1h]))

# 95th percentile model run duration
histogram_quantile(
  0.95,
  sum by (le, provider, model)
    (rate(openclaw_run_duration_seconds_bucket[5m]))
)

# Queue wait time SLO (95p under 2s)
histogram_quantile(
  0.95,
  sum by (le, lane) (rate(openclaw_queue_lane_wait_seconds_bucket[5m]))
) < 2

# Skill usage, split by bounded source
sum by (skill, source) (increase(openclaw_skill_used_total[24h]))

# Dropped Prometheus series (cardinality alarm)
increase(openclaw_prometheus_series_dropped_total[15m]) > 0

# Completed windows whose maximum delay exceeded one second
increase(openclaw_gateway_event_loop_delay_max_seconds_count[5m])
  - increase(openclaw_gateway_event_loop_delay_max_seconds_bucket{le="1"}[5m])

# Seconds represented by exported event-loop windows
increase(openclaw_gateway_event_loop_observed_seconds_total[5m])

# Observed GC entries whose elapsed duration exceeded one second
increase(openclaw_gc_duration_seconds_count[5m])
  - increase(openclaw_gc_duration_seconds_bucket{le="1"}[5m])
```

<Tip>
Prefer `gen_ai_client_token_usage` for cross-provider dashboards: it follows the OpenTelemetry GenAI semantic conventions and is consistent with metrics from non-OpenClaw GenAI services.
</Tip>

## Choosing between Prometheus and OpenTelemetry export

OpenClaw supports both surfaces independently. You can run either, both, or neither.

<Tabs>
  <Tab title="diagnostics-prometheus">
    - **Pull** model: Prometheus scrapes `/api/diagnostics/prometheus`.
    - No external collector required.
    - Authenticated through normal Gateway auth.
    - Surface is metrics only (no traces or logs).
    - Best for stacks already standardized on Prometheus + Grafana.

  </Tab>
  <Tab title="diagnostics-otel">
    - **Push** model: OpenClaw sends OTLP/HTTP to a collector or OTLP-compatible backend.
    - Surface includes metrics, traces, and logs.
    - Bridges to Prometheus through an OpenTelemetry Collector (`prometheus` or `prometheusremotewrite` exporter) when you need both.
    - See [OpenTelemetry export](/gateway/opentelemetry) for the full catalog.

  </Tab>
</Tabs>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Empty response body">
    - Check that `diagnostics.enabled` is not set to `false` in config (it defaults to `true`).
    - Confirm the plugin is enabled and loaded with `openclaw plugins list --enabled`.
    - Generate some traffic; counters and histograms only emit lines after at least one event.

  </Accordion>
  <Accordion title="401 / unauthorized">
    The endpoint requires the Gateway operator scope (`auth: "gateway"` with `gatewayRuntimeScopeSurface: "trusted-operator"`). Use the same token or password Prometheus uses for any other Gateway operator route. There is no public unauthenticated mode.
  </Accordion>
  <Accordion title="403 `missing scope: operator.read`">
    The caller authenticated, but its effective operator scopes do not include `operator.read`. This happens when an identity-bearing auth mode such as `trusted-proxy` maps the scraper to a [named role](/gateway/operator-scopes) whose scope ceiling excludes reads. Grant the scraper role `operator.read` (or `operator.write` / `operator.admin`, which imply it).
  </Accordion>
  <Accordion title="`openclaw_prometheus_series_dropped_total` is climbing">
    A new attribute is exceeding the **2048**-series cap. Inspect recent metrics for an unexpectedly high-cardinality label and fix it at the source. The exporter intentionally drops new series instead of silently rewriting labels.
  </Accordion>
  <Accordion title="Prometheus shows stale series after a restart">
    The plugin keeps state in memory only. After a Gateway restart, counters reset to zero and gauges restart at their next reported value. Use PromQL `rate()` and `increase()` to handle resets cleanly.
  </Accordion>
</AccordionGroup>

## Related

- [Diagnostics export](/gateway/diagnostics) — local diagnostics zip for support bundles
- [Health and readiness](/gateway/health) — `/healthz` and `/readyz` checks
- [Logging](/logging) — file-based logging
- [OpenTelemetry export](/gateway/opentelemetry) — OTLP push for traces, metrics, and logs
