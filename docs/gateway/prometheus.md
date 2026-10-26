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

Worker queue depths, wait times, and request durations are aggregated directly
from worker observations. Metrics collection does not enable per-request
diagnostic events; explicit diagnostic subscribers still receive those events.

<Warning>
The route uses Gateway authentication (operator scope, trusted-operator surface) and requires the caller's effective scopes to include `operator.read` (implied by `operator.write` or `operator.admin`). Do not expose it as a public unauthenticated `/metrics` endpoint. Scrape it through the same auth path you use for other operator APIs.
</Warning>

For traces, logs, OTLP push, and OpenTelemetry GenAI semantic attributes, see [OpenTelemetry export](/gateway/opentelemetry).

## Quick start

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/diagnostics-prometheus
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
| `openclaw_gateway_http_cancelled_total`                   | counter   | `source` (`client` or `shutdown`)                                                         |
| `openclaw_control_ui_document_duration_seconds`           | histogram | `stage`                                                                                   |
| `openclaw_gc_duration_seconds`                            | histogram | `kind`, `thread`                                                                          |
| `openclaw_gateway_rpc_requests_total`                     | counter   | `method`                                                                                  |
| `openclaw_gateway_rpc_client_requests_total`              | counter   | `method`, `client_kind`                                                                   |
| `openclaw_models_list_requests_total`                     | counter   | `client_kind`, `source`, `view`, `scope`, `refresh`, `prepared_only`                      |
| `openclaw_sessions_list_requests_total`                   | counter   | `client_kind`, `source`, `caller_source`, `row_mode`, `filter`                            |
| `openclaw_sessions_list_response_bytes_total`             | counter   | `client_kind`, `source`, `caller_source`, `row_mode`, `filter`, `rows_outcome`            |
| `openclaw_sessions_list_baseline_retirements_total`       | counter   | `cause`                                                                                   |
| `openclaw_sessions_list_base_misses_total`                | counter   | `reason`                                                                                  |
| `openclaw_chat_history_requests_total`                    | counter   | `client_kind`, `source`, `shape`, `limit_bucket`, `outcome`                               |
| `openclaw_chat_history_response_bytes_total`              | counter   | `client_kind`, `source`, `shape`, `limit_bucket`, `outcome`                               |
| `openclaw_cron_list_requests_total`                       | counter   | `client_kind`, `source`, `scope`, `compact`, `page`                                       |
| `openclaw_gateway_rpc_first_response_seconds`             | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_response_bytes`                     | histogram | `method`                                                                                  |
| `openclaw_gateway_ws_events_total`                        | counter   | `event`                                                                                   |
| `openclaw_gateway_ws_session_event_frames_total`          | counter   | `event`, `reason`, `delivery`                                                             |
| `openclaw_gateway_ws_session_event_bytes_total`           | counter   | `event`, `reason`, `delivery`                                                             |
| `openclaw_gateway_ws_event_bytes_total`                   | counter   | `event`                                                                                   |
| `openclaw_gateway_ws_event_wire_bytes_total`              | counter   | `event`                                                                                   |
| `openclaw_gateway_ws_event_frame_bytes`                   | counter   | `event`, `le`                                                                             |
| `openclaw_gateway_ws_presence_frames_total`               | counter   | `mode`                                                                                    |
| `openclaw_gateway_ws_presence_bytes_total`                | counter   | `mode`                                                                                    |
| `openclaw_gateway_ws_operator_connections`                | gauge     | none                                                                                      |
| `openclaw_gateway_rpc_handler_heap_delta_bytes`           | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_handler_heap_delta_exclusive_total` | counter   | `method`                                                                                  |
| `openclaw_gateway_rpc_handler_seconds`                    | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_admission_seconds`                  | histogram | `method`                                                                                  |
| `openclaw_gateway_rpc_queue_wait_seconds`                 | histogram | `method`                                                                                  |
| `openclaw_chat_send_phase_seconds`                        | histogram | `phase`, `stage` (`request`, `startup`, `steer`, or `queued`)                             |
| `openclaw_diff_stage_seconds`                             | histogram | `method`, `stage`, `outcome`                                                              |
| `openclaw_diff_cache_misses_total`                        | counter   | `method`, `reason`                                                                        |
| `openclaw_gateway_rpc_stage_seconds`                      | histogram | `method`, `phase`                                                                         |
| `openclaw_gateway_rpc_stage_thread_cpu_seconds`           | histogram | `method`, `phase`                                                                         |
| `openclaw_worktree_preparation_seconds`                   | histogram | `kind`, `template`, `outcome`, `phase`                                                    |
| `openclaw_gateway_rpc_outcomes_total`                     | counter   | `phase`, `outcome`                                                                        |
| `openclaw_run_completed_total`                            | counter   | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_run_duration_seconds`                           | histogram | `channel`, `model`, `outcome`, `provider`, `trigger`                                      |
| `openclaw_secret_egress_requests_total`                   | counter   | `outcome`, `substituted`                                                                  |
| `openclaw_tool_catalog_total`                             | counter   | `mode`, `source`                                                                          |
| `openclaw_tool_catalog_tools_total`                       | counter   | `mode`, `source`                                                                          |
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
| `openclaw_sessions_active`                                | gauge     | `state` (`running`, `queued`)                                                             |
| `openclaw_gateway_active_work`                            | gauge     | `kind` (`agentRuns`, `chatRuns`, `queuedTurns`)                                           |
| `openclaw_session_queue_depth`                            | gauge     | `state`                                                                                   |
| `openclaw_session_turn_created_total`                     | counter   | `agent`, `channel`, `trigger`                                                             |
| `openclaw_session_stuck_total`                            | counter   | `reason`, `state`                                                                         |
| `openclaw_session_stuck_age_seconds`                      | histogram | `reason`, `state`                                                                         |
| `openclaw_session_recovery_total`                         | counter   | `action`, `active_work_kind`, `state`, `status`                                           |
| `openclaw_session_recovery_age_seconds`                   | histogram | `action`, `active_work_kind`, `state`, `status`                                           |
| `openclaw_gateway_event_loop_delay_max_seconds`           | histogram | none                                                                                      |
| `openclaw_gateway_event_loop_observed_seconds_total`      | counter   | none                                                                                      |
| `openclaw_gateway_main_thread_stall_seconds`              | histogram | `task`                                                                                    |
| `openclaw_gateway_main_thread_stalls_dropped_total`       | counter   | none                                                                                      |
| `openclaw_liveness_warning_total`                         | counter   | `reason`                                                                                  |
| `openclaw_liveness_sessions`                              | gauge     | `state`                                                                                   |
| `openclaw_liveness_event_loop_delay_p99_seconds`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_event_loop_delay_max_seconds`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_event_loop_utilization_ratio`          | histogram | `reason`                                                                                  |
| `openclaw_liveness_cpu_core_ratio`                        | histogram | `reason`                                                                                  |
| `openclaw_payload_large_total`                            | counter   | `action`, `channel`, `plugin`, `reason`, `surface`                                        |
| `openclaw_payload_large_bytes`                            | histogram | `action`, `channel`, `plugin`, `reason`, `surface`                                        |
| `openclaw_memory_bytes`                                   | gauge     | `kind`                                                                                    |
| `openclaw_process_anonymous_memory_bytes`                 | gauge     | `kind` (`rss`, `swap`)                                                                    |
| `openclaw_heap_space_bytes`                               | gauge     | `space`, `stat`                                                                           |
| `openclaw_worker_count`                                   | gauge     | none (aggregate), `script`                                                                |
| `openclaw_worker_queue_depth`                             | gauge     | `kind`                                                                                    |
| `openclaw_worker_queue_wait_seconds`                      | histogram | `kind`, `request_class`                                                                   |
| `openclaw_worker_request_seconds`                         | histogram | `kind`, `request_class`                                                                   |
| `openclaw_worker_heap_sampled_count`                      | gauge     | none (aggregate), `script`                                                                |
| `openclaw_worker_heap_used_bytes`                         | gauge     | `script`                                                                                  |
| `openclaw_worker_heap_used_high_water_bytes`              | gauge     | `worker_class`, `script`                                                                  |
| `openclaw_worker_tasks_completed_total`                   | counter   | `worker_class`, `script`                                                                  |
| `openclaw_worker_gc_duration_seconds_total`               | counter   | `worker_class`, `script`, `kind`                                                          |
| `openclaw_worker_gc_collections_total`                    | counter   | `worker_class`, `script`, `kind`                                                          |
| `openclaw_worker_gc_reclaimed_bytes_total`                | counter   | `worker_class`, `script`, `kind`                                                          |
| `openclaw_worker_heap_space_used_bytes`                   | gauge     | `script`, `space`                                                                         |
| `openclaw_worker_external_bytes`                          | gauge     | `script`                                                                                  |
| `openclaw_worker_array_buffers_bytes`                     | gauge     | `script`                                                                                  |
| `openclaw_code_mode_worker_memory_bytes`                  | gauge     | `slot`, `kind` (`external`, `array_buffers`)                                              |
| `openclaw_worker_started_total`                           | counter   | `script`                                                                                  |
| `openclaw_worker_retired_total`                           | counter   | `script`, `reason`                                                                        |
| `openclaw_worker_messages_total`                          | counter   | `kind`, `direction`                                                                       |
| `openclaw_session_row_selections_total`                   | counter   | `kind`, `task`                                                                            |
| `openclaw_session_row_selection_rows_total`               | counter   | `kind`, `task`                                                                            |
| `openclaw_session_row_selection_resets_total`             | counter   | none                                                                                      |
| `openclaw_worker_message_payload_bytes_total`             | counter   | `kind`, `direction`                                                                       |
| `openclaw_worker_message_unmeasured_total`                | counter   | `kind`, `direction`                                                                       |
| `openclaw_child_process_spawn_total`                      | counter   | `family`, `operation`                                                                     |
| `openclaw_memory_rss_bytes`                               | histogram | none                                                                                      |
| `openclaw_memory_pressure_total`                          | counter   | `level`, `reason`                                                                         |
| `openclaw_telemetry_exporter_total`                       | counter   | `exporter`, `reason`, `signal`, `status`                                                  |
| `openclaw_prometheus_family_series_dropped_total`         | counter   | `family` (fixed metric-name catalog)                                                      |
| `openclaw_prometheus_series_dropped_total`                | counter   | none                                                                                      |
| `openclaw_diagnostic_async_queue_dropped_total`           | counter   | `drop_class`                                                                              |
| `openclaw_diagnostic_async_queue_length`                  | gauge     | none                                                                                      |

On Linux, `openclaw_process_anonymous_memory_bytes` reports `RssAnon` as `kind="rss"`
and `VmSwap` as `kind="swap"` from `/proc/self/status`, converted to bytes. The
existing diagnostic heartbeat reads these counters asynchronously. They include
managed heaps and buffers; they do not measure total native or allocator memory.
`VmSwap` excludes shared-memory swap. Unavailable counters are omitted, including
when a later read fails, rather than reported as zero or retained from an older
sample. Other platforms do not expose these gauges. OpenClaw does not currently
expose a total SQLite or jemalloc allocation counter.

Worker message counters describe posts and receives on Gateway main-thread worker transports,
with `direction="to_worker"` or `direction="from_worker"`. The fixed `kind` labels
separate SQLite requests and replies, task inputs and replies, task requests,
notifications, consumption receipts, admission, authority, resources, lifecycle,
memory, realtime, and other messages. Totals survive worker retirement and are
published with memory samples. Posts queued on a worker-bound port count when
accepted by the port, even if cancellation later prevents handing that port to a
worker. These counters describe transport work, not confirmed delivery.

Payload bytes use existing encoded buffer sizes or inexpensive owner estimates;
they exclude transport framing and do not measure structured-clone allocations.
Commit receipts reuse their already-computed serialized fact sizes. Memory reports
count numeric heap counters and GC durations; GC kind labels and object envelopes
are excluded. Authority includes transaction/commit admission and settlement, not
just authorization checks; arbitrary admission facts can still be unmeasured.
Object graphs without a known size increase `openclaw_worker_message_unmeasured_total`
instead of appearing as measured zero-byte messages. Compare byte rankings with
this coverage counter before drawing conclusions; nested worker-to-worker traffic
does not cross the main-thread boundary.

Foreign Worker instances with accessor or read-only methods, or nonextensible
instances, retain CPU and lifecycle tracking but exclude per-message traffic.
Instrumentation does not replace those protected methods.

Session-row selection counters report successful resident selections and returned
rows before federation and visibility filtering. `kind` is `broad`, `agent`,
`store`, `exact`, `session-id`, `parent`, or `running-candidate`. The bounded `task`
labels are `sessions.list`, `sessions.catalog.list`, `sessions.resolve`,
`sessions.usage`, `status`, `control-ui-pr`, and `other`. The task is the enclosing
instrumented operation, not necessarily the original cause of background work;
detached work without a recognized task is `other`. No session or agent identities
are exported. `openclaw_session_row_selection_resets_total` counts broad selection
invalidations, including topology replacement and projection disposal. These
process-lifetime totals travel with periodic memory samples; scrapes do not select
rows, and repeated samples do not increase the counters.

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

`openclaw_gateway_ws_events_total` counts outbound event frames accepted by the
sender, once per socket, so a broadcast to ten sockets counts ten frames.
`openclaw_gateway_ws_event_bytes_total` sums the encoded UTF-8 bytes of those full
JSON frames before WebSocket framing or compression. Neither counter proves
client receipt. Their only label is `event`: a known protocol event name, such as
`chat` or `sessions.changed`, or `other` for an unrecognized name. No payload,
session, user, or connection identifiers are exported. The
`openclaw_gateway_ws_operator_connections` gauge reports connected authenticated
operator sockets without labels. These observations use the existing bounded
diagnostic queue and shared exporter series cap. Event observations are batched
by event name within one event-loop turn while preserving per-socket frame and
byte totals. Connection counts update on
connect/disconnect and refresh every 30 seconds so a late-starting exporter or
dropped snapshot can recover.

`openclaw_gateway_ws_event_wire_bytes_total{event}` sums payload bytes actually
handed to the socket after the codec: deflated payload length when compressed,
raw length otherwise. It excludes WebSocket, TLS, and TCP headers and does not
prove client receipt. The codec can report completion after raw-frame acceptance;
direct local delivery contributes its raw payload size. Manual diagnostic
observations without a wire size do not fabricate a wire-byte measurement.

`openclaw_gateway_ws_event_frame_bytes{event,le}` contains cumulative counts of
accepted raw event frames, with byte-size upper bounds `256`, `512`, `1024`,
`2048`, `4096`, `8192`, `16384`, `65536`, and `+Inf`. Each frame increments all
matching bounds. This is a bounded bucket counter, not a histogram family: use
the metric name directly with `histogram_quantile`, without a `_bucket` suffix.

`openclaw_gateway_ws_presence_frames_total{mode}` and
`openclaw_gateway_ws_presence_bytes_total{mode}` split presence traffic by
`delta`, `reset` (full snapshots for capable clients), and `legacy` (full frames
without delta negotiation). They count the same accepted per-socket frames and
encoded bytes as the aggregate counters.

`openclaw_gateway_ws_session_event_frames_total` and
`openclaw_gateway_ws_session_event_bytes_total` attribute session event traffic
using the same per-socket frames and bytes as the aggregate counters.

The session counters use `event`, `reason`, and `delivery`. `event` is only
`sessions.changed` or `session.message`. For `sessions.changed`, `reason` is the
producer's reason (or lifecycle phase when no reason is present):
`abort`, `activity-summary`, `agent.input.settled`, `agent.run.started`,
`archive`, `board`, `branch-switch`, `chat.dispatch-error`, `chat.title`,
`cleanup`, `compact`, `create`, `cron-continuation`, `delete`, `dispatch`,
`fork`, `github-publication`, `goal`, `groups`, `involvement`, `move`, `new`,
`owner`, `participants`, `patch`, `placement`, `plugin-patch`, `progress-card-reset`,
`project`, `reclaim`, `recovery`, `reset`, `rewind`, `run-capacity`, `send`,
`sharing`, `steer`, `subagent-status`, `swarm-note`, `title`, `unarchive`,
`update`, `updated`, `worker-disk-space`, and `worker-runtime-install`.
Lifecycle phases are `start`, `model`, `end`, `error`, and `message`.
For `session.message`, `reason` is the message role: `user`, `assistant`, `system`,
`developer`, `tool`, or `toolResult`; an absent role uses `message`.
Unknown reasons, phases, and roles use `other`.
`delivery="subscribed"` means the recipient holds an exact
`sessions.messages.subscribe` subscription for that session, including its
producer-resolved alias; all other recipients use `delivery="roster"`.
This describes subscription membership, not whether a tab is visible or a peer
acknowledged receipt. Keyless roster invalidations use `roster`.
The counters reuse the existing encoded byte length without serializing again,
and batch by label set within the same event-loop turn. No message content,
IDs, or session keys enter the labels. Existing event counter labels stay unchanged.

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

`openclaw_gateway_rpc_client_requests_total` attributes all RPC methods using a
coarse handshake `client_kind`: `control-ui` (Control UI, WebChat UI, browser
copilot), `macos`, `ios` (including watchOS), `android`, `cli` (including TUI),
`node` (node hosts and workers), or `other`. The eighth bucket, `plugin`, is
reserved: generic `gateway-client` connections cannot reliably identify plugins,
and in-process plugin dispatch inherits its authenticated caller's identity.
Pre-authentication `connect` requests and other missing identities use `other`. This is diagnostic self-identification, never authorization.

The counter includes server-dispatched requests on behalf of a connection, such
as its initial model snapshot; use the dedicated list counters' `source` label
below to separate those from wire requests. No device IDs, display names,
platform strings, or request values become labels. There is no generic request
reason in the current protocol, so no `trigger` label is emitted; `cron.list`'s
`trigger` parameter filters job types and does not identify why a client fetched.

The budget is at most **8 additional samples and scrape series per method**,
created only for observed kinds and subject to the shared 16,384-sample cap.
Existing method-only counters and timing histograms keep their labels and bucket
counts. To attribute polling, use:

```promql
sum by (method, client_kind) (
  rate(openclaw_gateway_rpc_client_requests_total{method=~"cron.list|models.list"}[5m])
)
```

`openclaw_models_list_requests_total` separately attributes catalog reads to the
handshake's canonical client kind, such as `openclaw-control-ui`, `openclaw-macos`,
or `gateway-client`. `source="wire"` identifies client request frames;
`source="internal"` identifies server-dispatched requests with an adapted response,
including the connection's initial model snapshot. `view` is `default`,
`configured`, `provider-config`, `all`, or `other` for an invalid value. `scope`
records parameter presence: `session`, then `auth-profile`, then `agent`, or
`global` when none is supplied. `refresh` and `prepared_only` record whether the
corresponding parameter is exactly `true`. Counts include later-rejected requests;
scope does not describe the authorized result. No agent, session, profile,
connection, user-agent, or display-name values are exported. Each observed label
combination uses one sample in the existing shared cap. The method-only request
counter and timing histograms retain their existing labels.

`openclaw_sessions_list_requests_total` uses the same `client_kind` and `source`
attribution for session reads. `caller_source` records the protocol's bounded
caller tag (`sidebar`, `dashboard`, `activity`, `sessions-page`, `chat-pane`,
`agent-roster`, `command-palette`, or `skill-workshop`); missing or unknown tags
become `unspecified`. `row_mode` is `full` when omitted, `compact`, `dashboard`,
`sidebar`, or `other` for an invalid value. `filter` records the first matching
primary filter family: `search`, `children` (`spawnedBy`), `owner` (`ownerId`),
`involving` (`involvingMe=true`, `involvingProfileId`, or `profileRelation`),
`active` (`activeOnly=true` or `activeMinutes`), or `general` when none applies.
Other selection and presentation options do not add labels. Counts include
later-rejected requests and export no filter values, limits, offsets, or revision
tokens. Each observed combination uses one sample in the existing shared cap.

`openclaw_sessions_list_response_bytes_total` reuses these labels and adds
`rows_outcome`: `unchanged` for `rowsUnchanged`, `delta` for `rowsDelta`,
`full-no-base` for conditional replies when the request omits `ifRowsRevision`
or supplies an empty opt-in token, or `full-with-base` when it supplies a revision.
`full-with-base` includes
stale or evicted bases and the rare case where every row changed.
Non-sidebar row modes without the opt-in use `not-sidebar`. Diagnostics derives these labels from
the request and existing response fields without changing the protocol payload.

`openclaw_sessions_list_baseline_retirements_total{cause}` counts retirement
events, not rows or the number of views cleared. Causes are `projection-revision`,
`config`, `identity`, `selection-reset`, `view-evicted` (the 512-slot or 32 MiB
estimated-retention limit), and
`history-evicted` (the 32-generation limit). Only clears or evictions retaining
conditional rows or history count, including empty row lists. Selection-only
and non-conditional views do not count. When a read observes multiple invalidations,
`config` takes precedence
over `identity`, then `projection-revision`; an earlier selection reset already
clears the cache and is counted separately at that point.

`openclaw_sessions_list_base_misses_total{reason}` counts successful full conditional
replies with a nonempty `ifRowsRevision`. `unknown-base` means no eligible history
base was found, including after restart, eviction, or a non-delta revision token.
`all-rows-changed` means the base was found but the delta was not smaller than the
full row list (also possible for an empty list). The existing `full-with-base`
byte attribution stays unchanged. These reasons follow shared serialized replies
out-of-band; no response fields, revision tokens, or identifiers are exported.
Both counters use the bounded asynchronous diagnostics path and exporter cap.
Compare unknown-base misses with retirement events and process identity changes
to distinguish cache churn from first reads after restart; misses alone cannot
prove a restart. OpenTelemetry exports the same observations as
`openclaw.sessions.list.baseline_retirements` and `openclaw.sessions.list.base_misses`,
with the same `cause` and `reason` labels.

`openclaw_chat_history_requests_total` counts successful `chat.history` replies;
`openclaw_chat_history_response_bytes_total` sums their encoded response bytes.
Both use `client_kind` and `source` as above. `shape` uses the first matching
selector: `receipt` for `inputRunIds`, `pending` for `pendingBefore`, `older` for
a positive `offset`, `cursor` for `cursor`, `anchor` for `messageId`, otherwise
`tail`. `limit_bucket` is
`<=20`, `<=80`, `<=200`, or `>200`, with an omitted limit using the handler's
default of 200. `outcome` is the response `kind` (`delta` or `reset`), or `page`
for a normal history page. These counters exclude rejected, failed, and unsent
responses; `chat.startup` remains separate. The byte counters reuse the exact
UTF-8 JSON frame size from `openclaw_gateway_rpc_response_bytes`, before transport
framing or compression, without another serialization or per-row work. No cursor,
offset, identifier, text, or raw limit values become labels; each observed
combination uses one sample in the shared cap.

`openclaw_cron_list_requests_total` uses the same `client_kind` and `source`
attribution for cron reads. `scope` records parameter presence: `session` when
`sessionKey` is supplied, then `agent` for `agentId`, otherwise `global`.
`compact` records whether the parameter is exactly `true`; `page` is `append`
for a positive numeric offset and `first` otherwise. Counts include
later-rejected requests; scope does not describe the authorized result. No
session, agent, query, or offset values are exported. Each observed combination
uses one sample in the existing shared cap.

Outcome totals aggregate by phase and outcome without a
method dimension. Each method with all four timings, both byte histograms, and the exclusive-sample counter occupies eight aggregate
samples in the shared 16,384-sample cap. An RPC duration histogram occupies one sample
but expands into 44 scrape series (41 finite buckets, `+Inf`, sum, and count).
The four timing histograms therefore use 176 scrape series per method, compared
with 76 previously. Including request and exclusive-sample counters and both
byte histograms gives 236 series per fully observed method (23,600 for 100
methods), plus shared outcome totals. The response-size
and signed heap-delta histograms expand into 20 and 38 series respectively; see
[RPC response size and heap changes](/gateway/diagnostics#rpc-response-size-and-heap-changes). Existing samples keep
updating when a budget fills; unseen label sets for that family are refused
and increment both `openclaw_prometheus_series_dropped_total` and
`openclaw_prometheus_family_series_dropped_total{family="..."}`. Other families keep
their reserved capacity. Check the affected family's drop counter when
interpreting totals or latency percentiles. Async diagnostic queue saturation can
also drop observations, reported by `openclaw_diagnostic_async_queue_dropped_total`.

The four RPC timing histograms use these finite upper bounds, in seconds:

```text
0.005, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08,
0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8,
1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8,
10, 12.5, 15, 20, 25, 30, 60, 120, 300, 600
```

Between 10 ms and 30 s, adjacent bounds differ by at most a factor of 4/3.
Quantiles still interpolate within a bucket; they are estimates, not exact
observations. For example, a 995 ms p99 in the previous layout could represent
samples anywhere in the 500–1,000 ms bucket. The new layout splits that interval
at 600 and 800 ms. Other duration histograms retain their existing layouts.
The exporter uses classic Prometheus text histograms, not native histograms.

All previous boundaries remain available for threshold alerts. During upgrades,
keep targets with different bucket layouts separate for `histogram_quantile`,
or filter to the old common `le` values before aggregation. Wait for a full
query rate window after every target has upgraded before comparing quantiles
using the new boundaries; do not mix old and new layouts in recording rules.

### HTTP cancellations

`openclaw_gateway_http_cancelled_total` counts HTTP requests cancelled before
completion, with `source="client"` for disconnected clients and
`source="shutdown"` for Gateway shutdown. These expected cancellations do not
produce unhandled-request error logs. The metric carries no request URLs, file
paths, or client identifiers and follows the existing diagnostics enablement
and asynchronous queue limits.
Normal HTTP cancellations are not retained in the stability event buffer.

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

### Control UI documents

`openclaw_control_ui_document_duration_seconds` measures the Control UI HTML handler.
Its only label is `stage`: `auth_grants`, `identity_avatar`, `plugin_catalog`,
`git_branch`, `preferences`, `render`, or `total`. Preparation stages include awaited
work and run in parallel, so their durations must not be added together. `render`
includes HTML rewriting, CSP preparation, compression, and response submission;
`total` starts at handler entry and includes asset resolution. Neither includes
time queued before the handler or delivery to the browser. Only entered stages
are observed, including on failure; HEAD requests record `render` and `total`.
The JSON bootstrap endpoint and static assets do not contribute samples.
Queued diagnostic traces retain each stage's original start and end times.

### Session diff stages

`openclaw_diff_stage_seconds` records local `sessions.diff` and `checkout.diff`
reads below the one-second slow-log threshold. Labels are limited to `method`
(those two names), `outcome` (`cache-hit` or `cache-miss`), and six fixed stages:

| Stage              | Observation                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `admission`        | RPC receipt through handler admission and retained session-read preparation |
| `checkout-resolve` | Session, repository and managed base resolution before the local diff read  |
| `cache-validate`   | Revision validation, including waiting for a shared revision check          |
| `worker-queue`     | Worker admission wait for revision validation and any new diff collection   |
| `git-wall`         | Summed elapsed Git subprocess time during those worker operations           |
| `encode`           | Synchronous response preparation, encoding and transport handoff            |

`checkout.diff` records the cache and worker stages; `sessions.diff` adds request
admission, checkout resolution and response delivery. Durations are seconds.
Cache validation includes its worker queue and Git time, and concurrent Git
commands can overlap: do not add the stage values to estimate request latency.
A settled cached result is a hit; callers joining pending diff collection are
misses. Shared work contributes to each waiting caller, while later cache hits
never replay the cached result's old Git timings. No Git subprocesses means zero
Git wall time, even when filesystem revision validation is expensive.

`openclaw_diff_cache_misses_total` explains misses with a fixed `reason` label:
`cold`, `evicted`, `pending`, `no-revision`, `oversized`, or
`revision-changed-head`, `revision-changed-index`, `revision-changed-untracked-set`,
`revision-changed-worktree-mtime`, and `revision-changed-metadata`. When several
components change, the first in that order is reported. `pending` means the
caller joined an existing load. Only the most recent cache-capacity count of
evictions is remembered; older evicted keys report `cold`. Different request
shapes have separate entries, so there is no key-mismatch reason.

Unavailable revisions use bounded `no-revision-*` reasons where known:

| Suffix                        | Cause                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `environment`                 | Git discovery overrides, a custom runner, or changed worker environment                 |
| `platform`                    | Native filesystem revision reads are unavailable on this platform                       |
| `metadata`                    | The checkout or its Git directory pointers could not be resolved                        |
| `git-installation`            | Git's system config/attributes paths could not be discovered                            |
| `config`                      | Indirect, oversized, or nonregular config; includes, filters, or external path settings |
| `reftable`, `alternates`      | Ref or object storage needs fresh Git discovery                                         |
| `symlink`                     | Git metadata is indirect                                                                |
| `submodule`, `unmerged`       | Submodule status or unmerged status prevents reuse                                      |
| `status`                      | Git status failed or its output could not be represented exactly                        |
| `permission`, `missing`, `io` | Filesystem access failed, a path disappeared, or another read failed                    |

`oversized` retains its existing label for the 10,000-observation metadata budget
or 1 MiB status-output limit. The optional filesystem inventory includes ignored
files; exceeding it skips that shortcut, while full diffs can still reuse a
bounded changed-file revision. Shared Git refs and metadata have the same
observation budget. Oversized summaries retain their ten-second fallback cache
without repeating revision probes during that window.

`no-revision-missing` means a revision read encountered `ENOENT` or `ENOTDIR`,
not necessarily that the checkout itself is gone. Only a diff result reporting
`not_git` receives a one-second retry window, scoped to the request and Git
environment. Other unavailable results, such as an unknown commit, remain
immediately retryable.
No paths, config values, or error text become metric labels.

Diff revisions use Git's changed-file inventory and relevant file metadata.
Sessions launched from subdirectories or symlink aliases validate the physical
checkout root, just as diff collection does. A held `index.lock` does not disable
revision reads: Git status runs without optional index writes.
Ignored build output and index stat refreshes do not invalidate a result.
Unchanged large checkouts still run one read-only Git status check per shared
validation, but reuse diff collection. Unsupported layouts and inventories that
exceed the bounded revision budget keep fresh diff reads.
Small idle checkouts reuse the semantic revision while their complete filesystem
fingerprint is unchanged, avoiding a Git subprocess on each poll. This worker-local
memo is bounded to 64 entries and retains the existing 10,000-observation metadata
budget; any filesystem change requires Git validation again.

Only completed local cache reads have these outcomes. Remote repository reads,
unknown sessions and failures before cache selection retain the normal RPC
metrics. No paths, checkout IDs, session IDs or request data become labels.
These observations use the existing bounded diagnostic queue when diagnostics
and an interested trusted consumer are enabled. Compare each stage's count;
this metric is attribution for waiting callers, not total host work.

### Chat startup stages

`openclaw_gateway_rpc_stage_seconds{method="chat.startup",phase}` attributes
completed startup work with fixed labels:

| Phase                | Observation                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `session_entry`      | Exact session row preparation and initial access check                 |
| `pending_inputs`     | Pending-input page and orphaned-input reconciliation                   |
| `history_page`       | Transcript page read and display projection                            |
| `startup_projection` | Command preparation and optional settled model projections             |
| `projection_final`   | Final session row readiness, access revalidation and response assembly |
| `session_info`       | Synchronous session snapshot presentation                              |

Only entered phases contribute samples, including when they fail. These are
elapsed durations, including worker queues and scheduling; they do not report
CPU time. Phases can overlap: `session_info` is included in `projection_final`.
Startup projection preparation can overlap the history read. Do not sum
these phases as a request total; use the RPC handler duration for that total.
Labels contain no agent, session, account or transcript identifiers.

### Catalog list stages

For `sessions.catalog.list`, the stage histograms use six fixed phase labels:

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
16,384-sample cap. Startup-phase emission and its whole-process CPU semantics are
unchanged.

An OpenTelemetry exporter with traces disabled does not request phase events.
A configured Prometheus exporter records these observations as metrics without
requiring OpenTelemetry traces.

### Current sessions and work

Use `openclaw_sessions_active` for current session load. Its two series count
running and queued sessions using the same live-run projection as
`sessions.list` with `activeOnly: true`. The count covers the full operator
roster, including global and unknown sessions, before pagination; archived
sessions and cron-run history use the list's default exclusions. Compare with an
unfiltered operator list using `includeGlobal: true` and `includeUnknown: true`,
not a list restricted to one agent or viewer.

`openclaw_gateway_active_work` exposes three counts from the Gateway's existing
active-work snapshot:

| `kind`        | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `agentRuns`   | Admitted agent run contexts, including work that is not visible in the session roster. |
| `chatRuns`    | Registered chat runs that have not been aborted or requested registration cleanup.     |
| `queuedTurns` | Queued chat turns that have not been aborted.                                          |

These categories overlap. Do not sum them to obtain a total run or session
count. They cover session and run activity, not the complete suspension-blocker
inventory; zero alone does not establish that the Gateway can suspend.
Both gauges refresh on owner changes while the exporter is active,
without polling or reading transcripts. They return to zero when the relevant
work drains. Before the Gateway projection is ready, and after it stops, the
series are absent rather than reporting an assumed idle state.

`openclaw_session_state_total` is a **cumulative counter of state observations
since exporter start**, not a current session count or a count of unique
sessions. Repeated observations of `processing` keep increasing it; completion
does not decrement it. For example, `processing=60` can coexist with zero live
sessions. Use `rate(openclaw_session_state_total[5m])` to measure observation
frequency. `openclaw_session_queue_depth` is likewise only the latest observed
individual session queue depth per diagnostic state, not total queued work.

```promql
sum(openclaw_sessions_active)
openclaw_gateway_active_work{kind="queuedTurns"}
```

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

### Main-thread stall attribution

`openclaw_gateway_main_thread_stall_seconds{task}` records individual main-thread
tasks lasting at least 250 milliseconds. Its `_count` counts recorded tasks;
`_sum` totals their elapsed seconds. Buckets are 0.25, 0.5, 1, 2.5, 5, and 10
seconds, plus `+Inf`. The `task` label comes from code-owned work scopes and passes
through the exporter's normal label sanitizer and series cap. It contains no
request IDs or message content.

`openclaw_gateway_main_thread_stalls_dropped_total` counts records omitted when
the attribution buffer fills. It appears only after the first loss; the histogram
appears only after the first recorded stall. Diagnostic queue drops and exporter
restarts can also lose observations, so an absent histogram does not establish
that no stalls occurred. Unlike event-loop window maxima, these observations
attribute elapsed execution to a work scope; they do not provide CPU profiles.

### Worker request queues

`openclaw_worker_queue_depth{kind}` reports requests awaiting dispatch across
worker owners of that kind. It includes SQLite writer capacity waiters and scoped
read-only requests, and excludes requests that already hold an execution slot.
`openclaw_worker_queue_wait_seconds{kind,request_class}` measures enqueue to
dispatch; `openclaw_worker_request_seconds{kind,request_class}` measures dispatch
to reply or failure. Both use the existing duration histogram buckets. Cancellation
before dispatch removes the queued request without adding a duration sample.

`openclaw_worker_request_phase_seconds{kind,request_class,phase}` breaks completed
SQLite writer requests into observed intervals, using the same histogram buckets:

| Phase      | Interval                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| `dispatch` | Slot allocation through host preparation to the first `postMessage`.     |
| `delivery` | First `postMessage` to worker receipt, including cold worker startup.    |
| `input`    | Worker receipt to complete command reconstruction, including all frames. |
| `prepare`  | Command reconstruction to backend execution.                             |
| `execute`  | Backend execution, including owner code, admission exchanges, and SQL.   |
| `result`   | Execution end through cleanup, serialization, and result framing.        |
| `reply`    | Final reply preparation and posting through broker receipt.              |

The Prometheus subscription enables these timestamps without a restart or a
diagnostic flag. Large result transfers remain in `result`; input and result
frames produce one sample per phase for the complete request. Missing or invalid
intervals produce no sample. Open, close, and failed requests may omit phases they
never reached. `postMessage` completion overlaps worker activity and is not added
as another phase. Caller scheduling after broker receipt is outside these phases.

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
as `audit.writer.process`, `database.walMaintenance`, and `stateLease.renew`.
Unknown commands retain `execute`; unknown request classes become `other`.
The allowlists bound cardinality without publishing session IDs, database paths,
command suffixes, or caller-provided names. The exporter's shared series cap still
applies.

The `transcripts` request family includes stored event appends and retention.

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

# Where SQLite writer requests spend their observed wall time
sum by (request_class, phase) (rate(openclaw_worker_request_phase_seconds_sum[5m]))

# Shared-state read rate, by operation family
sum by (request_class) (rate(openclaw_worker_request_seconds_count{kind="stateRead"}[5m]))
```

### Memory and process churn

#### Heap headroom and a sustained-pressure alert

On Node, the following gauges use `thread="main"` or the existing bounded
worker script names (including `other`). They never label by thread ID, session,
or path:

| Metric                                        | Meaning                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw_heap_size_limit_bytes`              | V8 heap limit; smallest limit among fresh workers of a script                                                                    |
| `openclaw_heap_used_ratio`                    | Current used heap divided by that isolate's limit; largest ratio among fresh workers of a script                                 |
| `openclaw_heap_old_generation_after_gc_bytes` | `old_space` plus `large_object_space` at the last observed major-GC epilogue; largest byte count among fresh workers of a script |
| `openclaw_heap_old_generation_after_gc_ratio` | That post-GC byte count divided by the isolate's limit; largest individual ratio among fresh workers of a script                 |

The existing native GC profiler records the post-GC baseline at collection time,
then drains on its existing one-second cadence. Allocations between collection
and the next memory heartbeat do not change that baseline. Minor collections do
not replace it. No additional timer, forced collection, heap snapshot, or
per-collection JavaScript callback is installed. Baselines are absent until a
major collection is observed, and reset when the isolate's last GC observer
stops. Native-only worker fallback samples cannot report post-GC baselines.
Bun omits these V8-specific gauges.

Use the exported ratios directly: dividing grouped byte gauges by grouped
limits can combine different workers. A script's ratio describes its most
pressured sampled isolate, not an average or a permanently identified worker.
Workers without a fresh sample are excluded; use the coverage counts below to
detect missing observations.

For Prometheus alerting (or an equivalent Grafana alert with a 10-minute pending
period), start with:

```yaml
groups:
  - name: openclaw-heap
    rules:
      - alert: OpenClawSustainedHeapPressure
        expr: openclaw_heap_old_generation_after_gc_ratio > 0.70
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "OpenClaw retained heap exceeds 70% of its V8 limit"
          description: "Inspect heap headroom, worker coverage, GC duration, and external memory before reducing the heap limit."
```

The last observed post-GC baseline persists between major collections; this rule
does not require another collection during the pending period. For worker groups,
different isolates can supply the maximum over that period. External memory and
ArrayBuffers are separate from the V8 heap limit. Their existing main/worker
metrics remain necessary, and ArrayBuffers are already included in external
memory.

Node does not expose a supported JavaScript count-only near-heap-limit callback.
Consequently these metrics do not include a native near-limit callback count.
The snapshot/profile near-limit APIs write diagnostic artifacts and are not
enabled by this exporter. Existing sampled memory-pressure warnings remain
available, but are not native near-limit notifications and cannot guarantee
warning before a rapid fatal allocation. Adding the rule to your Prometheus or
Grafana installation is a separate operator action.

#### Memory samples and worker coverage

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
Both count metrics also expose `script="..."` series: `openclaw_worker_count`
counts all live Workers for that script, including those awaiting or missing a
fresh sample, while `openclaw_worker_heap_sampled_count` counts its fresh samples.
The original unlabeled series retain the aggregate totals. Select
`{script!=""}` when summing script series to avoid counting the aggregate again.
`openclaw_worker_heap_used_bytes{script="..."}` sums fresh heap samples for each
Worker script. `openclaw_worker_external_bytes` and `openclaw_worker_array_buffers_bytes`
sum the corresponding available counters from those same samples by `script`.
ArrayBuffer bytes are included in external memory; do not add them together.
Native-only heap samples provide external memory but no ArrayBuffer count, so
ArrayBuffer totals can cover fewer Workers than the heap sample count. Missing
counters are omitted, while measured zero bytes are exported as zero.
On Node, `openclaw_worker_heap_space_used_bytes{script="...",space="..."}` sums
used bytes by V8 heap space for Workers serving the private memory channel. It
shares the existing heartbeat, sample expiration, and exit cleanup. Space names
come from V8's finite native set; labels contain no paths, account details, or
catalog contents. Compare old, large-object, and code spaces to locate worker
heap growth without a snapshot. Native-only fallback samples and Bun omit these
space counters, so their coverage can be smaller than the heap sample count.
`openclaw_heap_space_bytes` remains the main isolate's separate space breakdown.
Labels use a fixed allowlist of runtime-entrypoint, pooled, and bundled plugin Worker basenames, normalized to
`.js` in source and packaged runs; unknown, eval, and unwrapped third-party Workers
use `other`. Full paths and eval source are never recorded. A script's series
disappears when it has no live, fresh samples; its count series disappear when
it has no live Workers. Memory-pressure logs include the
same byte counts and Worker coverage counts, plus `workerHeaps`: the five largest
individual fresh Worker heaps as `{script, heapUsed, heapTotal}` (bytes), using the same
bounded script names.

Session transcript database lanes retire after five idle minutes, releasing their
isolate heaps along with retained readers. A request resets the lane's idle
deadline; active reads and host callbacks finish before retirement. The next
request recreates the lane's workers through normal database admission. The
separate SQLite handle retention window remains 30 minutes.

`openclaw_worker_started_total{script="..."}` and
`openclaw_worker_retired_total{script="...",reason="..."}` expose cumulative
starts and confirmed native exits through the same heartbeat. Retirement reasons
are `idle_timeout`, `memory_pressure`, `closed`, `rotation`, `cancelled`,
`failure`, `eviction`, `idle-expiry`, `dispose`, `shutdown`, `crash`, `gc-thrash`,
or `exit` when an owner did not specify a reason. Code Mode distinguishes warm-cache
eviction, idle expiry, explicit disposal, host shutdown, native crash, and GC-watchdog
retirement; see [Code Mode executors](/tools/code-mode/executors).
A retirement request
does not count until the Worker exits; failed termination and retries do not
double-count. Counters survive exporter restarts and reset with the process.
Use `60 * rate(openclaw_worker_started_total[5m])` for starts per minute by
script. These counts share the registry coverage limits above; they do not
measure resident memory released by an exit.

`openclaw gateway call diagnostics.lanes --json` also reports `workerCount`,
`postgresBridgeCount`, `workerPoolCount`, and `workerPools`. The bridge count also
includes bridges inside registered worker parents; direct bridges overlap
`workerCount`, so the two counts must not be added. Each pool entry contains a process-local
`poolId`, an allowlisted `script`, and its live `workerCount`. The response lists
the 100 largest live pools; `workerPoolCount` includes all live pools. Counts
include pending retirements until native exit and disappear when a pool has no
live Workers. Direct Workers contribute to `workerCount` without a pool entry.
These are JavaScript Worker counts, not an operating-system thread census.

`openclaw_child_process_spawn_total{family="...",operation="..."}` counts successful launches
through OpenClaw's shared spawn and exec owners, including brokered and native
PTY launches, and the streaming workspace inventory runner. Windows PTYs are
attributed at their first output or exit after their asynchronous PID publication.
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
`workspace.result-cleanup`, `session.materialize`, or `publication`. Direct host runners also identify
`github.identity`, `project.checkout`, `update.inspect`, `worktree.config`,
`worktree.maintenance`, `workspace.sync`, and `workspace.result`. Worker operations retain their admitted
owner when the parent launches Git, including parallel batches and retries.
Streaming workspace inventory and pack commands default to `workspace.inventory`
while preserving an admitted surrounding owner.
Git launches without an admitted owner use a fixed `unscoped.<command>` label,
such as `unscoped.config`, `unscoped.rev-parse`, or `unscoped.status`.
Global Git options and their values are skipped before classifying the command;
unrecognized commands, aliases, and option layouts use `unscoped.other`.
These labels replace `unknown` for unscoped launches, so update queries that
select that label. Invalid explicit owners still use `unknown`.
Other executable families use bounded owners such as `agent.exec`, `shell.snapshot`,
and `service.relay`, or fixed fallback classifications such as
`unscoped.shell-command`, `unscoped.shell`, `unscoped.runtime`, `unscoped.version`,
`unscoped.gh`, and `unscoped.command`. Relays for agent exec retain `agent.exec`.
SQLite read launches retain their `sqlite.scoped-read.broker`,
`sqlite.scoped-read.native`, `sqlite.session.broker`, or `sqlite.session.native` labels.
Update queries selecting `operation="none"` to select the relevant owners or
remove the operation filter to retain the per-family view. Linux OOM-protection
exec wrappers report the logical target family, since the broker can omit the shell.
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

### Pool worker task and GC totals

Shared compute workers can finish and retire between scrapes. Their task and GC
counters accumulate in the existing worker registry across retirement and pool
recreation. The diagnostics heartbeat republishes these absolute totals without
double-counting. They reset with the Gateway process; an exporter restart recovers
the registry's totals on the next heartbeat.

Labels contain a bounded `worker_class` (`reader`, `file-reader`, `compute`,
`writer`, `singleton`, or `other`) and the allowlisted `script` basename described
above. GC counters also carry the same `kind` values as
`openclaw_gc_duration_seconds`. No worker, pool, session, or task ID is exported.

`openclaw_worker_tasks_completed_total` counts observed terminal task replies,
including handled failures. `openclaw_worker_gc_duration_seconds_total` and
`openclaw_worker_gc_collections_total` record elapsed GC seconds and collection
counts. `openclaw_worker_gc_reclaimed_bytes_total` sums positive differences
between heap usage before and after each observed collection. Reclaimed bytes are
an allocation-pressure proxy, not exact allocated bytes: retained allocations,
external memory, and garbage not yet collected are excluded.

`openclaw_worker_heap_used_high_water_bytes` retains the largest observed
individual worker heap usage for each label set. It is a gauge for context, not a
byte counter or a sum of simultaneous worker heaps. It can miss peaks between
samples, and remains visible after the last worker exits.

Workers report through the existing periodic memory channel. The native sampler
drains worker GC batches every 100 ms (the main thread remains at one second).
Task replies carry
only a completion marker, without a heap read or another per-task round trip.
Healthy retirement flushes the last GC batch and heap sample over the same channel
before stopping the worker, with a 100 ms best-effort limit. Collection requires
enabled diagnostics and an interested consumer. Tasks before activation are not
backfilled. Forced termination, crashes, cancellation, or a retirement flush timeout
can lose the unfinished interval; periodic reports preserve earlier observations.
Bun does not provide native GC samples, so its GC counters are absent. The existing
GC histogram remains available for duration distributions.

For provider prompt preparation, compare GC seconds and reclaimed bytes per
completed task over the same workload window:

```promql
sum(rate(openclaw_worker_gc_duration_seconds_total{worker_class="compute",script="provider-prompt-state.worker.js"}[5m]))
/
sum(rate(openclaw_worker_tasks_completed_total{worker_class="compute",script="provider-prompt-state.worker.js"}[5m]))
```

```promql
sum(rate(openclaw_worker_gc_reclaimed_bytes_total{worker_class="compute",script="provider-prompt-state.worker.js"}[5m]))
/
sum(rate(openclaw_worker_tasks_completed_total{worker_class="compute",script="provider-prompt-state.worker.js"}[5m]))
```

Use windows with completed tasks; an empty denominator does not establish zero
cost. A task is not necessarily an agent turn, so use a matching turn counter
when the workload can issue multiple tasks per turn. For GC seconds per created
agent turn, align both sides to the same Gateway and workload window:

```promql
sum by (instance) (increase(openclaw_worker_gc_duration_seconds_total{worker_class="compute",script="provider-prompt-state.worker.js"}[30m]))
/
sum by (instance) (increase(openclaw_session_turn_created_total[30m]))
```

Replace the numerator with `openclaw_worker_gc_reclaimed_bytes_total` for reclaimed
bytes per created turn. Keep the same traffic mix and allow in-flight turns and
worker retirement to settle at window boundaries. Compare the retained heap
high-water separately with
`openclaw_worker_heap_used_high_water_bytes{worker_class="compute",script="provider-prompt-state.worker.js"}`;
do not apply `rate()` to that gauge. Before/after windows must both have these
metrics enabled; earlier deployments cannot be backfilled.

### Garbage collection duration

`openclaw_gc_duration_seconds` records elapsed garbage collection (GC) duration
reported by Node.js for the main isolate and instrumented workers. `kind` is
`scavenge` (minor), `mark_sweep_compact` (major), `incremental`, or
`weak_processing`, taken from the native GC profile's collection type. `thread` is `main`
or an allowlisted worker script basename; unknown worker scripts use `other`.
Native sampling reports `reason="other"`: `GCProfiler` does not expose callback
flags. SDK producers may still supply the bounded callback-flag labels `none`,
`forced`, `synchronous_phantom_processing`, `all_available_garbage`,
`all_external_memory`, `schedule_idle`, or `construct_retained`. These flags are
not V8's complete internal reason for starting a collection.

Code Mode Node workers also carry a reusable `slot` label from 1 through 64.
The worker registry holds a slot until native worker exit, including pending
retirement, then makes it available for reuse. Concurrent workers beyond 64
retain script-level attribution without a slot; other worker scripts also retain
script-level attribution. Slots are not thread IDs or session identities.
Counters accumulate across occupants of a slot, so a rate window can span more
than one worker. Older SDK
producers that omit attribution use `kind="unknown",reason="other",thread="main"`. SDK-provided
unknown kinds and worker names fold into `unknown` and `other` at event emission.
Each observation is one
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
Disabling diagnostics or stopping the heartbeat disconnects the main observer
immediately and sends worker disconnect requests over their existing memory
telemetry ports. A busy worker processes the request when its event loop resumes;
exports are suppressed in the meantime.

The histogram is absent until the first observation, so absence does not prove
zero GC. At startup, the exporter reserves four slots within the GC family's
384-entry reserve for native main-thread GC (`reason="other"`), so startup traffic cannot prevent
these histograms from appearing later. Reservation does not add observations.
Queue drops, the series cap for other GC labels, observation gaps and process restarts limit
coverage. Diagnostics disable/re-enable preserves the exporter's existing
counters; restarting the exporter resets them as usual. One shared native profiler
per isolate drains on an unreferenced one-second timer instead of scheduling
JavaScript after each GC. Sampling does not force GC or collect application payloads.
Worker GC batches
reuse the memory telemetry port; port closure stops its observer. Workers without
that port, nested workers outside this registry, and runtimes without native GC
entries are not covered. Worker exit can lose a final undelivered batch.

The histogram's `_count` and `_sum` are the collection count and total elapsed
seconds for each label set. Existing queries that need a single total should
aggregate the new labels; select `thread="main"` to retain main-isolate scope:

```promql
sum by (kind, thread) (rate(openclaw_gc_duration_seconds_count[5m]))
sum by (kind, thread) (rate(openclaw_gc_duration_seconds_sum[5m]))
```

To locate a busy Code Mode isolate and compare its latest used heap with its
actual V8 limit:

```promql
60 * sum by (slot, reason) (
  rate(openclaw_gc_duration_seconds_count{thread="code-mode-node.worker.js",kind="mark_sweep_compact",slot!=""}[5m])
)
openclaw_code_mode_worker_heap_bytes{kind="used"}
  / ignoring(kind) openclaw_code_mode_worker_heap_bytes{kind="limit"}
```

`openclaw_code_mode_worker_heap_bytes` reuses the existing memory heartbeat and
labels samples by `slot` and `kind="used"` or `kind="limit"`. Gauges disappear at
the next memory sample after worker exit or stale sampling; missing limits are
omitted on runtimes without V8. The script-level worker heap metrics continue to
include all workers, including slot overflow. No additional heap interrupt or
sampling timer is introduced.

`openclaw_code_mode_worker_memory_bytes` exposes the same slots with
`kind="external"` and `kind="array_buffers"`, using the counters already carried
by the memory heartbeat. Missing counters are omitted, and gauges disappear on
the next memory sample after exit or stale sampling, just like the heap gauges.
Slot overflow remains included in the script-level totals. These counters do
not account for every native allocation or allocator arena.

OpenTelemetry's `openclaw.gc.duration_ms` uses the corresponding
`openclaw.gc.kind`, `openclaw.gc.thread`, and optional `openclaw.gc.worker_slot`
attributes.

## Label policy

<AccordionGroup>
  <Accordion title="Bounded, low-cardinality labels">
    Prometheus labels stay bounded and low-cardinality. The exporter does not emit raw diagnostic identifiers such as `runId`, `sessionKey`, `sessionId`, `callId`, `toolCallId`, message IDs, chat IDs, or provider request IDs.

    Label values are redacted and must match OpenClaw's low-cardinality character policy. Values that fail the policy are replaced with `unknown`, `other`, or `none`, depending on the metric. Labels that look like scoped agent session keys are also replaced with `unknown`.

  </Accordion>
  <Accordion title="Series cap and overflow accounting">
    The exporter retains at most **16,384 aggregate label sets** across counters, gauges, and histograms. Each histogram consumes one entry, regardless of its bucket count; the rendered scrape has more time series. The WebSocket frame-size family is different: its nine cumulative scalar bounds each consume an entry, so 200 event names use 1,800 entries.

    A fixed catalog of 137 metric families reserves **15,512 entries**, leaving **872 shared entries**. Each family can retain at most **128 entries** or its reserve, whichever is larger. Unused reserves are not borrowed. This protects late RPC, run, model, tool, GC, and memory observations from startup traffic in other families. Existing entries continue updating after admission fills. Gauge replacement releases its entries and preserves its family's reserve.

    The following reserves apply per family (all names have the `openclaw_` prefix):

    | Reserve | Families |
    | --- | --- |
    | 2,048 | `gateway_ws_event_frame_bytes` |
    | 1,024 | `worker_request_phase_seconds` |
    | 640 | `worker_heap_space_used_bytes` |
    | 512 | `gateway_rpc_client_requests_total`, `worker_queue_depth`, `worker_queue_wait_seconds`, `worker_request_seconds` |
    | 384 | `gc_duration_seconds` |
    | 256 | All other `gateway_rpc_*` families; `gateway_ws_event_bytes_total`, `gateway_ws_event_wire_bytes_total`, `gateway_ws_events_total`, `gateway_ws_session_event_bytes_total`, `gateway_ws_session_event_frames_total`; `heap_space_bytes` |
    | 128 | `run_completed_total`, `run_duration_seconds`, `harness_run_total`, `harness_run_duration_seconds`, `model_call_total`, `model_call_duration_seconds`, `model_cost_usd_total`, `model_failover_total`, `model_tokens_total`, `model_usage_duration_seconds`, `gen_ai_client_token_usage`, `tool_catalog_total`, `tool_catalog_tools_total`, `tool_execution_blocked_total`, `tool_execution_total`, `tool_execution_duration_seconds`, `code_mode_worker_heap_bytes`, `code_mode_worker_memory_bytes`, `heap_old_generation_after_gc_bytes`, `heap_old_generation_after_gc_ratio`, `heap_size_limit_bytes`, `heap_used_ratio`, `memory_bytes`, `worker_count`, `worker_heap_sampled_count`, `worker_heap_used_bytes`, `worker_external_bytes`, `worker_array_buffers_bytes`, `worker_gc_collections_total`, `worker_gc_duration_seconds_total`, `worker_gc_reclaimed_bytes_total`, `worker_heap_used_high_water_bytes`, `worker_tasks_completed_total` |
    | 64 | `session_row_selections_total`, `session_row_selection_rows_total`, `worker_started_total`, `worker_retired_total`, `worker_message_payload_bytes_total`, `worker_message_unmeasured_total`, `worker_messages_total` |
    | 32 | `chat_send_phase_seconds`, `worktree_preparation_seconds` |
    | 4 | Every other cataloged family |

    These budgets cover 170 RPC methods (including two client kinds per method), 400 worker request/queue label sets, 400 worker phase label sets, 200 WebSocket event names, 390 worker heap-space label sets, and 250 main/worker GC label sets without using the shared pool. Worker heap spaces multiply `script × space`; GC can multiply `thread × kind × reason × slot`. The GC `reason` and reusable Code Mode `slot` labels retain callback attribution and per-isolate correlation with heap samples. Worker phases multiply `kind × request_class × phase`: 400 fully timed request combinations would need 2,800 phase entries, exceeding that family's 1,024-entry limit. Reservations guarantee capacity, not unlimited cardinality.

    Rejected new-series observations increment `openclaw_prometheus_series_dropped_total` and `openclaw_prometheus_family_series_dropped_total{family="..."}`. Repeated observations of the same rejected label set increment again; these counters do not count unique rejected sets. Both counters bypass admission, so saturation cannot hide drops. The family label comes only from the fixed catalog, never from diagnostic label values. The exporter also logs one warning per affected family per process, including across exporter restarts.

    Drop counters reset when the exporter stops. Drops can reflect legitimate combinations of bounded labels as well as an upstream cardinality leak. Inspect the named family before changing its labels or budget. The exporter never raises its cap automatically; the family reserve is a guarantee of capacity, not complete coverage for arbitrarily many label combinations.

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

# Raw outbound WebSocket event bytes per second by event, including fan-out
sum by (event) (rate(openclaw_gateway_ws_event_bytes_total[5m]))

# Post-codec outbound payload bytes per second by event
sum by (event) (rate(openclaw_gateway_ws_event_wire_bytes_total[5m]))

# p50 raw event frame size by event; use 0.90 for p90
histogram_quantile(0.50,
  sum by (event, le) (rate(openclaw_gateway_ws_event_frame_bytes[5m])))

# Model catalog calls per minute by caller and request shape over ten minutes
60 * sum by (client_kind, source, view, scope, refresh, prepared_only)
  (rate(openclaw_models_list_requests_total[10m]))

# Session list calls per minute by caller and request shape over ten minutes
60 * sum by (client_kind, source, caller_source, row_mode, filter)
  (rate(openclaw_sessions_list_requests_total[10m]))

# Cron list calls per minute by caller and request shape over ten minutes
60 * sum by (client_kind, source, scope, compact, page)
  (rate(openclaw_cron_list_requests_total[10m]))

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

# Families losing new label sets (do not sum this with the aggregate counter)
sum by (family) (increase(openclaw_prometheus_family_series_dropped_total[15m])) > 0

# Completed windows whose maximum delay exceeded one second
increase(openclaw_gateway_event_loop_delay_max_seconds_count[5m])
  - increase(openclaw_gateway_event_loop_delay_max_seconds_bucket{le="1"}[5m])

# Seconds represented by exported event-loop windows
increase(openclaw_gateway_event_loop_observed_seconds_total[5m])

# Observed GC entries whose elapsed duration exceeded one second
increase(openclaw_gc_duration_seconds_count[5m])
  - increase(openclaw_gc_duration_seconds_bucket{le="1"}[5m])
```

Run, harness-run, model-call (including synthetic model turns), and message-dispatch
duration histograms preserve the existing bounds through 600 seconds and add
900, 1800, and 3600 seconds. Each label set expands into 22 scrape series.
Other duration histograms keep their existing bounds.

Percentiles remain bucket-based estimates; observations above one hour still
fall only in `+Inf`. Upgrading cannot recover the distribution of historical
overflow samples. During a rolling upgrade, avoid pooling instances with
different bucket layouts, and use a query window containing only samples from
the new layout when evaluating long-run percentiles.

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
    A family ceiling or the shared overflow budget is full. Inspect `openclaw_prometheus_family_series_dropped_total` and the once-per-family warning to identify affected metrics. Check label combinations and the family's reserved capacity. The exporter drops new label sets without rewriting them, while protecting other families' reserves.
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
