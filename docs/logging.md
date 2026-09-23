---
summary: "File logs, console output, CLI tailing, and the Control UI Logs tab"
read_when:
  - You need a beginner-friendly overview of OpenClaw logging
  - You want to configure log levels, formats, or redaction
  - You are troubleshooting and need to find logs quickly
title: "Logging"
---

OpenClaw has two main log surfaces:

- **File logs** (JSON lines) written by the Gateway.
- **Console output** in the terminal running the Gateway.

The Control UI **Logs** tab tails the gateway file log. This page explains where
logs live, how to read them, and how to configure log levels and formats.

## Where logs live

By default, the Gateway writes a rolling log file per day. The default profile
keeps the historical path:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Named profiles use a profile-qualified filename in the same directory:

`/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`

The filename profile segment is lowercase and limited to letters, numbers, and
dashes. Simple lowercase names stay readable, so the `--dev` shorthand writes
`openclaw-dev-YYYY-MM-DD.log`. Case, underscores, and literal dashes use a
reversible dash escape so distinct profile names never share a log file.
Oversized values set directly through the environment use a bounded hash suffix
to stay within filesystem filename limits. An explicit `logging.file` overrides
these defaults.

The date uses the gateway host's local timezone. When `/tmp/openclaw` is unsafe
or unavailable (and always on Windows), OpenClaw uses a user-scoped
`openclaw-<uid>` directory under the OS temp dir instead. Dated log files are
pruned after 24 hours.

Each file rotates when the next write would exceed `logging.maxFileBytes`
(default: 100 MB). OpenClaw keeps up to five numbered archives beside the
active file, such as `openclaw-YYYY-MM-DD.1.log` or
`openclaw-dev-YYYY-MM-DD.1.log`, and keeps writing to a fresh active log instead
of suppressing diagnostics.

You can override the path in `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## How to read logs

### CLI: live tail (recommended)

Tail the gateway log file via RPC:

```bash
openclaw logs --follow
openclaw --dev logs --follow
openclaw --profile work logs --follow
```

The root profile selector resolves the same profile-specific file used by the
Gateway, including CLI fallback reads when local RPC is unavailable.

Options:

| Flag                | Default  | Behavior                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `--follow`          | off      | Keep tailing; reconnects with backoff on disconnect                                   |
| `--limit <n>`       | `200`    | Max lines per fetch                                                                   |
| `--max-bytes <n>`   | `250000` | Max bytes to read per fetch                                                           |
| `--interval <ms>`   | `1000`   | Poll interval while following                                                         |
| `--json`            | off      | Line-delimited JSON (one event per line)                                              |
| `--plain`           | off      | Force plain text in TTY sessions                                                      |
| `--no-color`        | —        | Disable ANSI colors                                                                   |
| `--utc`             | off      | Render timestamps in UTC (local time is default)                                      |
| `--local-time`      | off      | Accepted compatibility spelling for the local-time default; no effect beyond it       |
| `--url` / `--token` | —        | Standard Gateway RPC flags                                                            |
| `--timeout <ms>`    | `30000`  | Gateway RPC timeout                                                                   |
| `--expect-final`    | off      | Agent-backed RPC final-response wait flag (accepted here via the shared client layer) |

Output modes:

- **TTY sessions**: pretty, colorized, structured log lines.
- **Non-TTY sessions**: plain text.

When you pass an explicit `--url`, the CLI does not auto-apply config or
environment credentials; include `--token` yourself, or the call fails with
`gateway url override requires explicit credentials`.

In JSON mode, the CLI emits `type`-tagged objects:

- `meta`: stream metadata (file, source, sourceKind, service, cursor, size)
- `log`: parsed log entry
- `notice`: truncation / rotation hints
- `raw`: unparsed log line
- `error`: gateway connection failures (written to stderr)

If the implicit local loopback Gateway asks for pairing, closes during connect,
or times out before `logs.tail` answers, `openclaw logs` falls back to the
configured Gateway file log automatically. Explicit `--url` targets do not use
this fallback. `openclaw logs --follow` is stricter: on Linux it uses the active
user-systemd Gateway journal by PID when available, and otherwise retries the
live Gateway with backoff instead of following a potentially stale side-by-side
file.

If the Gateway is unreachable, the CLI prints a short hint to run:

```bash
openclaw doctor
```

### Control UI (web)

The Control UI's **Logs** tab tails the same file using `logs.tail`.
See [Control UI](/web/control-ui) for how to open it.

### Channel-only logs

To filter channel activity (WhatsApp/Telegram/etc), use:

```bash
openclaw channels logs --channel whatsapp
```

`--channel` defaults to `all`; `--lines <n>` (default 200) and `--json` are also
available.

## Log formats

### File logs (JSONL)

Each line in the log file is a JSON object. The CLI and Control UI parse these
entries to render structured output (time, level, subsystem, message).

File-log JSONL records also include machine-filterable top-level fields when
available:

- `hostname`: gateway host name.
- `message`: flattened log message text for full-text search.
- `agent_id`: active agent id when the log call carries agent context.
- `session_id`: active session id/key when the log call carries session context.
- `channel`: active channel when the log call carries channel context.

OpenClaw preserves the original structured log arguments alongside these fields
so existing parsers that read numbered tslog argument keys keep working.

Talk, realtime voice, and managed-room activity emits bounded lifecycle log
records through this same file-log pipeline. These records include event type,
mode, transport, provider, and size/timing measurements when available, but omit
transcript text, audio payloads, turn ids, call ids, and provider item ids.

### Console output

Console logs are **TTY-aware** and formatted for readability:

- Subsystem prefixes (e.g. `gateway/channels/whatsapp`)
- Level coloring (info/warn/error)
- Optional compact or JSON mode
- Structured fields on `warn`, `error`, and `fatal` records, appended as one
  compact `key=value ...` tail (nested values as JSON, capped at 2 KiB) so
  plain-text sinks such as journald keep the diagnostics; `info` and lower
  console lines stay message-only, and the file log always carries the full record.
  These fields go through the same redaction as the `json` console style before
  they are flattened, so a sensitive key such as `apiToken` is masked by name and
  the length cap can only clip text that is already masked

Console formatting is controlled by `logging.consoleStyle`.

SQLite worker diagnostics use stderr. After the final backend closes normally,
the worker gives pending console output up to five seconds to drain before
acknowledging close. This is best effort; forced worker termination can still
discard pending diagnostics.

### Gateway WebSocket logs

`openclaw gateway` also has WebSocket protocol logging for RPC traffic:

- normal mode: only interesting results (errors, parse errors, slow calls)
- `--verbose`: all request/response traffic
- `--ws-log auto|compact|full`: pick the verbose rendering style
- `--compact`: alias for `--ws-log compact`

Examples:

```bash
openclaw gateway
openclaw gateway --verbose --ws-log compact
openclaw gateway --verbose --ws-log full
```

## Configuring logging

All logging configuration lives under `logging` in `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/path/to/openclaw.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Log levels

Levels: `silent`, `fatal`, `error`, `warn`, `info`, `debug`, `trace`.

- `logging.level`: **file logs** (JSONL) level (default: `info`).
- `logging.consoleLevel`: **console** verbosity level.

You can override both via the **`OPENCLAW_LOG_LEVEL`** environment variable (e.g. `OPENCLAW_LOG_LEVEL=debug`). The env var takes precedence over the config file, so you can raise verbosity for a single run without editing `openclaw.json`. You can also pass the global CLI option **`--log-level <level>`** (for example, `openclaw --log-level debug gateway run`), which overrides the environment variable for that command.

`--verbose` only affects console output and WS log verbosity; it does not change
file log levels.

### Provider request failures

Anthropic-compatible HTTP failures preserve the HTTP status separately from a
bounded, redacted response body. JSON error bodies are parsed before diagnostic
redaction and preview truncation, so a long proxy error does not lose its status
or upstream rejection reason merely because the console preview is short.
Oversized or malformed bodies can still be omitted by the diagnostic redactor.

Chat displays recognized request-limit facts, including the allowed and actual
number of `cache_control` blocks, in both live failures and saved history. Raw
proxy metadata stays in redacted diagnostics rather than the chat message.

Saved failed replies also distinguish rate limits, authentication failures,
provider HTTP errors, and network interruptions. Worker inference preserves
bounded, redacted error details for classification, including when a large
partial response cannot fit in the transcript. Unrecognized errors still use
generic chat copy; inspect the Gateway logs and stored error for diagnosis.

Responses output-identity conflicts record the event type, output position,
expected and observed item types, and whether a tool call completed, without
recording item IDs or response content. OpenClaw uses the existing bounded session
retry policy when the failing response produced no visible text or completed tool
calls and its request enabled only client-executed function tools. Continuation
keeps earlier tool results, so those completed actions are not replayed. Conflicts
after output or with provider-hosted tools remain terminal; inspect earlier
results before continuing. Previously emitted text remains terminal even if a
later snapshot clears it. Automatic recovery requires a successful completed
response without a refusal; conflicts before that terminal cannot be retried
because the final outcome is unknown. Failed or incomplete terminal responses,
including content filtering, cannot be overridden by identity recovery. The
identity checks stay enforced on every attempt.

A worker message-size failure is separate from a model context-window limit.
Retry with a smaller response or continue on the Gateway. If the worker cannot
preserve the model's continuation data, stop or reclaim it before retrying on
the Gateway. Earlier tool actions may already have completed, so check their
results before repeating them.

### Targeted model transport diagnostics

When debugging provider calls, use targeted environment flags instead of raising
all logs to `debug`:

```bash
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 openclaw gateway
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools OPENCLAW_DEBUG_SSE=events openclaw gateway
```

Available flags:

- `OPENCLAW_DEBUG_MODEL_TRANSPORT=1`: emit request start, fetch response, SDK
  headers, first streaming event, stream completion, and transport errors at
  `info` level.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`: include a bounded request payload
  summary in model request logs.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=tools`: include all model-facing tool names in
  the payload summary.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`: include a redacted, capped JSON
  payload snapshot. Use only while debugging; secrets are redacted but prompts
  and message text may still be present.
- `OPENCLAW_DEBUG_SSE=events`: emit first-event and stream-completion timing.
- `OPENCLAW_DEBUG_SSE=peek`: also emit the first five redacted SSE event
  payloads, capped per event.
- `OPENCLAW_DEBUG_CODE_MODE=1`: emit code-mode model-surface diagnostics,
  including bounded activation facts, the final visible surface, and names of
  provider-native tools filtered because code mode owns the tool surface.

These flags log through normal OpenClaw logging, so `openclaw logs --follow`
and the Control UI Logs tab show them. For backward compatibility,
`OPENCLAW_DEBUG_CODE_MODE` also promotes general model-transport diagnostics to
`info`; dedicated code-mode diagnostics are emitted only when that flag is
enabled.

`[model-fetch]` start and response metadata (provider, API, model, status,
latency, and request fields such as method, URL, timeout, proxy, and policy)
uses `debug` by default. Responses with a non-2xx status or at least one second
of elapsed time remain at `info`, and transport failures remain warnings.
Elapsed time includes local-service preparation and waiting for response headers,
but excludes streaming the response body. The targeted debug flags above promote
start and fast successful response metadata to `info` when troubleshooting.

`[anthropic] replayed thinking dropped: N block(s)` is a warning when Anthropic
reports dropping invalidated thinking from replay. It includes the mismatch
reasons and up to five affected message paths, not the thinking content. No
debug flag is required.

`[anthropic] server-side context edit: cleared N tool results (M input tokens)`
is an info-level line when Anthropic reports applying server-side tool-result
clearing. It contains counts only, without tool arguments or result content, and
requires no debug flag. See [Session pruning](/concepts/session-pruning#direct-anthropic-api-key-requests)
for the routes and thresholds that enable clearing.

### Trace correlation

File logs are JSONL. When a log call carries a valid diagnostic trace context,
OpenClaw writes the trace fields as top-level JSON keys (`traceId`, `spanId`,
`parentSpanId`, `traceFlags`) so external log processors can correlate the line
with OTEL spans and provider `traceparent` propagation.

Gateway HTTP requests and Gateway WebSocket frames establish an internal request
trace scope. Logs and diagnostic events emitted inside that async scope inherit
the request trace when they do not pass an explicit trace context. Agent run and
model-call traces become children of the active request trace, so local logs,
diagnostic snapshots, OTEL spans, and trusted provider `traceparent` headers can
be joined by `traceId` without logging raw request or model content.

Talk lifecycle log records also flow to diagnostics-otel log export when
OpenTelemetry log export is enabled, using the same bounded attributes as file
logs. Configure `diagnostics.otel.logsExporter` to choose OTLP, stdout JSONL, or
both sinks.

### Embedded attempt preparation

Embedded `prep stages` summaries separate two tool-preparation intervals:

- `bundle-tools`: awaited MCP/LSP preparation, tool normalization and policy
  projection, measured after preparation admission.
- `tool-catalog`: synchronous catalog construction, including Code Mode or tool
  search when enabled, schema projection and tool diagnostics.

`tool-preparation` is an inclusive checkpoint from the preceding bootstrap
checkpoint. It includes both intervals, preparation admission waits and the
remaining bootstrap work. These entries overlap: do not sum them or interpret
them as CPU time. Later permission refreshes do not append initial-preparation
entries. The conditional Code Mode and tool-search catalog messages still report
their original activation/compaction events.

Older summaries charged bundle waiting to `code-mode` or `tool-search` and used
`bundle-tools` for a later bookkeeping checkpoint. Those names do not provide
the same timing boundaries as the corrected spans.

The summary keeps its existing identity fields and warning thresholds: ten
seconds total or five seconds in any recorded stage; faster summaries use trace
logging. A missing summary does not prove preparation completed without delay.

### Session catalog provider waits

With process diagnostics enabled, the `gateway/session-catalog` logger records
`slow session catalog provider list` for attempts that settle after at least one second.
`admissionWaitMs` records initial provider admission waiting. `providerElapsedMs`
spans the first provider invocation through final logical settlement, including
waiting between steps of a stepped fill. `completionDelayMs` begins after final
settlement and queue release. The Gateway's earlier operator-start queue is separate.

`stepCount` counts admitted callbacks. `admittedStepMs` sums their elapsed time
through actual settlement, including authority checks, factory work, and I/O
waits. `continuationWaitMs` measures queue waiting after an incomplete step until
resumption or cancellation; it excludes initial admission. These fields are not
an exact disjoint partition and do not measure CPU time.

`admitted` and `providerInvoked` distinguish an attempt that never entered the
queue's active slot from one that called the provider. Unreached intervals are
omitted. `outcome` reports the attempt's resolution or rejection;
`signalAborted` reports the signal independently and does not identify an error's
cause or prove that native work stopped. An active provider call or `next()` step
keeps its slot until its actual promise settles, including after cancellation.
An inert continuation queues with other callers between steps.

`providerIdHash` hashes provider IDs of at most 256 UTF-16 units; longer IDs omit
the field. It supports correlation, not anonymization or authorization. Host
summaries count only returned gateway/node kinds, connection flags and error
presence, inspecting at most 512 hosts. `returnedHostCount` reports the full
array length and `hostCountsComplete=false` marks partial counts. No session rows,
host IDs, provider labels, search text or error messages are included.

Each summary describes an underlying provider attempt. Cached and in-flight
followers can receive several RPC responses from that one attempt. Later
`waitUntil` host publications have a separate lifetime and are not included in
the provider duration or returned-host counts. The log does not prove client
receipt, identify which native operation was slow, or cover attempts that never
settle. Missing records do not establish that there were no stalls.

### Codex catalog phases

The same `gateway/session-catalog` logger records three Codex summaries when
process diagnostics and warning-level logging are enabled. Each summary is
emitted only after its observed operation settles and takes at least one second:

- `slow Codex catalog list phases` covers the plugin's list operation.
  `managedSnapshotMs`, `controlWaitSumMs`, `exclusionMarkSumMs`, `adoptionSumMs`
  and `mappingMs` identify reached work. Counts include `localHostCount`,
  `controlPageCalls`, `exclusionMarkCalls` and `adoptionCalls`.
  `managedSnapshotMs` is absent when the optional snapshot method or store is
  unavailable. `nodeRegistryCalls` and `nodeRegistryMs` measure the existing node
  registry invocation; `pairedNodeCalls`, `pairedNodeSettled` and `nodeWaitSumMs`
  describe the paired-node promises reached by the list. Cache counters
  `coldStarts`, `refreshStarts`, `freshHits`, `staleHits` and `pendingJoins`
  distinguish new producers, background refreshes, immediate cached delivery
  and callers awaiting an existing cold page.
- `slow Codex catalog page producer` measures one control-page calculation.
  `listOperationId` identifies its originating list when observed. `origin` is
  `cold`, `refresh` or `uncached`. `controlRequestCalls` counts
  entered control requests; `inclusiveControlRequestWaitMs` sums their elapsed
  waits and `inclusiveControlRequestWaitMaxMs` reports the longest one.
  `postResponseMs` covers subsequent provenance checks and page projection.
  `provenanceChecks`, `provenanceCacheHits`, `provenanceReadCalls` and
  `provenanceMs` describe the existing provenance path. `provenanceReadCalls`
  counts calls to the metadata reader, not filesystem read syscalls or chunks.
  `stopReason`, when reached, is `exhausted`, `limit` or `page-bound`.
- `slow Codex catalog cache wait` measures a caller waiting for a pending cold
  page. `producerOperationId` links it to an observed producer;
  `listOperationId` links the surrounding list when available.
  `producerObserved=false` means the producer's diagnostic identity is
  unavailable, not that no producer exists.

Page-producer summaries also accumulate elapsed time at the existing control
phase transitions. Repeated phases, including selection retries, and multiple
control calls contribute to the same page totals. Each total is rounded only
when the summary emits. Unreached phases are absent; a reached phase may report
zero milliseconds.

Rejected control calls can add `controlFailurePhase` and
`controlFailureCategory`. The failure phase uses the same logical boundaries:

| Control phase    | Elapsed field            | Boundary                                                                                                                         |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `load-control`   | `controlLoadMs`          | Loading and entering the control module before the request owner reports its first phase.                                        |
| `prepare`        | `controlPrepareMs`       | Options, guards, imports, or argument/budget evaluation before acquisition or client API entry.                                  |
| `acquire-client` | `controlAcquireClientMs` | Shared-client selection, process-registration preparation, possible startup, authentication, initialization, and readiness.      |
| `client-request` | `controlClientRequestMs` | The client API was invoked; readiness, shared native-request waiting, retries and caller continuation can still occur inside it. |
| `release-client` | `controlReleaseClientMs` | Logical lease release or cleanup, including a later deadline decision after cleanup. This is not proof of physical process exit. |

These are caller-observed intervals, frozen when that control invocation reports
failure or closes. They exclude underlying work continuing after an outward
timeout. A call on an already-pinned connection can omit acquisition and release
because the surrounding pin owns those operations. Setup/settlement gaps and
rounding mean the phase totals need not exactly equal the inclusive wait.

Categories are `deadline-observed`, `scoped-rejection`,
`rpc-method-unavailable` (typed RPC error code `-32601`), `rpc-error`, or `other`.
They use existing owner decisions and typed errors, without copying exception
messages, stacks, response data, or arbitrary error codes. Plain startup,
transport, and other unclassified errors remain `other`; the category does not
identify their cause. Public unavailable-host messages remain sanitized.

Successful cleanup preserves an earlier error's phase unless the outer request
owner observes its deadline. For `deadline-observed`, the phase is the active
stage at that later decision, even if cleanup just completed. For example,
`release-client/deadline-observed` can follow budget exhaustion before the client
API was ever invoked; it does not prove cleanup caused the deadline. A cleanup
error that replaces the request error reports `release-client`. Internally
handled retries and successful requests do not publish failure fields, and late
callbacks cannot overwrite a settled observation.

These fields do not prove a native request was written, a native process failed,
or a response reached the client. The containing list can resolve with an
unavailable host after a control call rejects.

`operationId` is local to `diagnosticEpoch`, PID and thread. It is not a session,
native request or audit execution identity. One producer can serve several
waiters, and a stale refresh can continue after a list returns. `outcome=resolved`
means that the observed operation returned; a resolved list can include
disconnected or error-bearing hosts.

All timings are elapsed time, including asynchronous waits. The inclusive
control-request interval and its logical phase totals do not isolate physical
request writes, wire latency or native CPU, and do not prove that a native
process stopped. Several callers can be waiting on the same underlying work.
Provenance time is included in post-response time, and host work can overlap,
so sums need not partition the list's elapsed time. `nodeWaitSumMs` sums existing
paired-node promise waits; it is not a disjoint node phase or proof of native
completion. If the list closes while a child promise is unsettled,
`pairedNodeCalls` can exceed `pairedNodeSettled` and the sum is partial. Later
host publications retain their separate lifetime. Unreached timings are omitted,
while a reached stage may report zero milliseconds.

The tracker admits at most 64 active diagnostic observations per JavaScript
runtime isolate and shares a budget of 60 records per fixed 60-second window
across these three summaries. These limits suppress observations, not catalog
work. Each record's metadata is capped at 28 scalar fields and 2 KiB, excluding
the logger envelope. `omittedObservations` reports accumulated capacity, rate
or metadata-limit suppression on a later emitted record. Window-boundary bursts
remain possible. Disabled diagnostics, logging levels, short operations,
non-settlement or logging failures can also leave no record.

The records contain fixed labels, counts, timings and diagnostic operation
identity. They omit connection fingerprints, queries, cursors, homes, paths,
session/thread identifiers, titles, credentials and raw errors. Existing trace
context may accompany the log; no trace or audit identity is created. These are
ordinary performance logs and do not change [audit collection](/gateway/audit),
authorization, cache behavior or deadlines. Their sanitized attributes may flow
through an already-enabled [OpenTelemetry log exporter](/gateway/opentelemetry/privacy-and-trace-context)
even when content capture is off. Missing logs do not prove an absence of stalls.

### Lifecycle queue waits

When process diagnostics are enabled, the `sessions/lifecycle` logger emits
`session lifecycle queue waiting` once when a queue acquisition is still pending
after one second. It identifies the `mutation` or `lifecycle` queue and samples
its current holder at that instant. The holder can have changed since the
waiter entered the queue. A delayed timer that runs after acquisition emits no
holder sample.

`operationId` and `holderOperationId` identify diagnostic operation instances
within `diagnosticEpoch`, PID and thread. Operations use the fixed boundary
labels `lifecycle`, `mutation` and `compaction`; they do not name arbitrary
callers. Existing request traces appear in `operationTraceId`/`operationSpanId`
and separate `holderTraceId`/`holderSpanId` fields when present. Missing trace
fields remain unknown; no new trace or audit execution identity is created.

`identityHash` is a salted digest of the already-normalized store/session
identity. It correlates only inside the same JavaScript runtime isolate and
diagnostic epoch. Raw session keys and paths are omitted. The digest is
operational correlation, not anonymization or authorization evidence.

`slow session lifecycle operation` records operations taking at least one
second through their actual queued work's settlement. It separates
`mutationQueueWaitMs`, `lifecycleQueueWaitMs`, `completionDelayMs` and
`phaseDurationsMs.prepare`, `.run` and `.finalize`. The holder's current
`holderPhase` can also identify activation, admission or release work. A
`lifecycle` operation describes its queue attempt after the existing active-
mutation idle wait; that prior idle wait is not measured here. Calls with no
normalized identities have no queue and emit no queue-operation summary. A
caller can cancel before all of its queued work unwinds; `signalAborted`
reports the signal without claiming that the holder has released.

The tracker preserves outer ownership across reentrant work and retires a
holder only when its actual queue callback exits. Its state weakly follows
existing queue objects; it does not create another execution queue. Per
runtime isolate, it retains at most 128 holder descriptors and 32 one-shot
wait timers, and emits at most 60 records per minute. The queue timing owner
explicitly distinguishes reentry, so unobserved outer holders stay unknown at
capacity or after enablement. `omittedObservations` on a later record reports
suppressed observations; missing records never prove no wait.

Elapsed intervals can include asynchronous waits and nested work, so phase
and queue totals need not form a disjoint partition. A holder sample identifies
who owns that queue at the sampled instant, not every predecessor responsible
for the entire wait or which work consumed CPU. These are ordinary performance
logs. They do not use or change [audit identity](/gateway/audit), decisions,
retention, principal attribution or admission authority.

### Worker pool capacity

Gateway `status` responses include `workerPools.transcriptReconciliation` and
`workerPools.modelCatalog`. Each reports `maxWorkers`, `workers`, `workersCreated`,
`activeTasks`, and `pendingTasks` from the pool owner. Both Gateway pools admit one
worker at a time. Pending tasks include queued and executing work; creation counts
belong to the current pool lifetime. The startup trace's `memory.ready` record also
includes these pool counts.

These figures describe worker and task counts. Process RSS includes every isolate
and native allocation; Node's process heap flags can override a worker's requested
heap limits. Use constructor or per-isolate measurements when attributing memory
growth to a particular worker.

### Slow worktree cleanup

With process diagnostics and info-level logging enabled, two subsystems log
operations lasting at least one second after they return or throw:

- `agents/worktrees`: `slow managed worktree removal` measures removal through
  allocation-lease settlement. `admissionMs` covers acquisition attempts,
  backoff, setup, and scheduling before the removal callback starts. `bodyMs`
  covers that callback; `finalizeMs` covers drainage, final authority checks,
  lease release, and completion delivery. Create and restore operations do not
  emit this record.
- `git/ref-mutation`: `slow Git ref mutation` measures shared Git-ref queue
  operations. `resolveMs` covers common-directory resolution; `queueWaitMs`
  covers time from enqueue to callback entry; `queuedOperationMs` covers the
  callback and delivery of its settlement. It can include multiple Git commands
  and does not identify a queue holder or every predecessor.

Removal also records the stages reached inside `bodyMs`:

- `preparationMs`: authority and removal-claim checks, repository rebinding, and
  worktree lock inspection or unlock.
- `snapshotMs`: snapshot preparation and publication, including provisioned-file
  capture and snapshot-failure cleanup.
- `checkoutRemovalMs`: deletion admission checks and physical Git worktree
  removal through result validation.
- `bodyFinalizeMs`: branch deletion, prune, empty-parent cleanup, registry
  finalization, or removal-claim cleanup after failure. This is distinct from
  `finalizeMs`, which measures the allocation-lease wrapper's final settlement.

Unreached stages are absent; a reached stage can report zero milliseconds.
Exceptions close the active stage and include claim cleanup in `bodyFinalizeMs`.
These fields subdivide the admitted body, not individual Git commands or CPU
work. They use the same completion record and rate budget.

Both records include `durationMs` in integer milliseconds, `callbackEntered`, and
`outcome` (`returned` or `threw`). Removal that never enters its callback reports
all elapsed time as `admissionMs` and omits `bodyMs` and `finalizeMs`. Git directory
resolution failure reports `resolveMs` and omits unreached queue and operation
durations. Phase durations partition each record's interval before rounding.
These intervals include asynchronous waits: admission is not pure lock wait,
and queued operation time is not child-process CPU time. They nest within
broader operations such as session-patch `worktreeCleanup`; do not add nested
durations to the enclosing total.

Each subsystem has a separate fixed budget of 60 records per 60-second window
per JavaScript runtime isolate. Bursts across window boundaries remain possible.
`omittedObservations` reports suppressed records on the next emitted record,
then resets. Pending operations emit nothing until they settle; disabled
diagnostics, log levels, thresholds, and budgets can also leave no record.
Missing records never prove there was no delay.

The added fields are fixed scalar timings, outcomes, counts, `pid`, `threadId`,
and `isMainThread`. They omit repository paths, refs, arguments, raw errors, and
command output. Records preserve an existing valid diagnostic trace when
available; they create no trace, operation identity, or private-identity hash.
Use the trace to associate nested records, without treating elapsed time as CPU
attribution. These diagnostics measure cleanup without changing its ordering or
completion behavior.

### Slow agent database opens

The `slow OpenClaw agent database open` warning includes `phaseDurationsMs` when
a persistent database open takes at least one second:

| Phase           | Work included                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `open`          | Permissions, handle eviction, and opening the connection.                                               |
| `validation`    | Integrity, version, and owner checks, including Worker waiting and revalidation during async admission. |
| `configuration` | Connection and WAL settings.                                                                            |
| `schema`        | Schema initialization or convergence when needed.                                                       |
| `registration`  | Post-validation eviction and permissions, cleanup setup, and shared-state registration.                 |

The integer millisecond durations partition `elapsedMs`, measured with a
monotonic clock after lease acquisition. Live cache hits remain quiet. These
are elapsed durations, including asynchronous waits, rather than CPU time or
proof that the main event loop was blocked for the whole interval.

The structured warning also includes `pid`, Node's `threadId`, and `isMainThread`
for the opener emitting it. Inspect each `openclaw logs --json` event's original
`raw` record; warn-level console text also carries these fields as `key=value` pairs.
An opener on the main thread may have awaited an integrity Worker, so these
fields do not identify the thread performing every phase. `admissionMode` records
the actual `sync` or `async` open driver. Async admission offloads its initial
integrity check; resumed validation and repair can still run on the opener.
Correlate the process ID with the log timestamp and current process; PIDs can be
reused after exit.

`integrityGateMs` covers the initial integrity check through admission
revalidation and resumption. When the driver measures its synchronous integrity
and foreign-key callback, `integrityCheckSyncMs` reports that callback's elapsed
time and `integrityOutsideCheckMs` reports the remaining gate time. The two
integer fields partition `integrityGateMs`; the remainder includes admission,
IPC, scheduling, and revalidation, not just a parent queue wait. These are wall
durations, not CPU time. A reclamation Worker can report this synchronous check
while its `admissionMode` is `async`. An asynchronous child-process check leaves
both fields absent because its parent cannot measure the callback itself.

SQLite reclamation Workers also emit `slow SQLite reclamation Worker operation`
at `warn` when their joined operation takes at least one second. The record is
emitted after Worker exit and parent admission settlement. It includes the
parent's `pid`, `threadId` and `isMainThread`, the actual Node `workerThreadId`,
`reclamationKind`, `elapsedMs`, terminal `outcome` (`resolved` or `rejected`), and
`exitCode`. Timing starts after admission to the archive Worker queue and includes
startup, validation, admission waits, work, and cleanup. It does not measure CPU
time or isolate a validation phase. Short writer sections can therefore remain
quiet while this whole-operation warning exposes slow preparation between them.
The record inherits an existing parent trace when available. Failed retained
reclamation operations also include `sessionIdHash` (when targeting one session),
`error` (the redacted message and causes), and `errorFrame` (the first stack frame).
These failures emit one warning even below one second, named
`SQLite reclamation Worker failed`; slower failures use the existing slow-operation
warning. Session identifiers use the same hash as other session SQLite diagnostics;
the failure fields are redacted and bounded to 2,048 characters each.
Cold-storage operations use the same warning with `reclamationKind` set to
`cold-batch` (archive or externalize), `cold-maintain` (reclaim free pages), or
`cold-restore` (restore a transcript). Their writer warnings carry the same Worker
identity and numbered admission fields.

### SQLite transaction timing

The `sqlite/transaction` warnings `slow SQLite transaction hold`,
`slow SQLite transaction step`, and `SQLite transaction lock wait failed`
include `database`, `operation`, `pid`, Node's `threadId`, and `isMainThread` for
the thread executing the transaction. Explicit labels take precedence; otherwise
diagnostics use the native database path and the current Worker operation.
An in-memory database is `:memory:`, a retired handle is `unavailable`, and a
caller without operation context is `unlabeled`. Hold warnings also include
`mode` (`deferred` or `immediate`). Inspect the original `raw` record in `openclaw logs --json` to
distinguish the main thread from Workers sharing the same process. `async: false`
describes the synchronous transaction helper; it does not identify the thread.

Hold time starts after `BEGIN` succeeds. It includes the synchronous callback,
result checks, and settlement through `COMMIT` or rollback. JavaScript work and
host admission waits inside the transaction count toward its hold. It excludes
database opening and `BEGIN`, but overlaps the separately timed `COMMIT` step.
Overlapping deferred read holds do not establish that multiple writers held a lock.

Successful begin and commit step timings include native execution, storage work,
and scheduling delays; they do not establish lock contention. The separate
`SQLite transaction lock wait failed` warning identifies caught SQLite lock
errors. These elapsed durations do not measure SQL CPU time or establish a
causal link to a nearby request.

The operation `session.reclamation.commit-settlement` identifies the parent's
synchronous join after it authorizes a reclamation Worker to commit. Its lock
wait is separate from the Worker's integrity scan and deletion work. This label
also applies to cold-storage operations using that commit boundary.

Hot transcript reads identify their purpose in `operation`: `session transcript
<purpose> read`, where `<purpose>` is `identity`, `header`, `tail`, `incremental`,
`checkpoint`, `events`, `raw rows`, `storage rows`, or `match`. These fixed labels
distinguish readers without retaining session IDs or transcript content. Nested
reads remain part of the outer transaction's timing; older warnings use the
generic `session transcript hot read` label.

`session branch summaries read` covers the snapshot read and branch-summary
computation. Stored sessions perform this work in a background Worker; incognito
sessions use their process-held database. Cache hits do not perform this scan.

Immediate `BEGIN` warnings also include `beginAdmission`: `nativeAttempts` counts
actual native `BEGIN IMMEDIATE` calls and `nativeMs` measures those calls;
`serviceCalls` counts synchronous admission-service callbacks and `serviceMs`
measures them. A service callback may find no work, so its count does not mean
that reclamation was authorized. Failed attempts and throwing callbacks retain
their partial measurements. Deferred `BEGIN` and `COMMIT` have no breakdown.

These fields use the same wall clock as the unchanged `elapsedMs` total. Native
time excludes busy-timeout configuration and restoration; other bookkeeping can
leave a remainder. A service can synchronously join another transaction, whose
time is already included in the outer `serviceMs`; do not add nested warnings
together. The breakdown does not identify CPU time or a physical lock holder.

### SQLite session writes

The `session-sqlite` subsystem emits `slow SQLite session write` when total
elapsed time reaches 1000 ms, and `SQLite session write failed` when a write
fails. Both warnings include `operation`, a label from a fixed set of semantic
operation names identifying the callback that owns the SQLite writer lane.

The timing fields separate the elapsed interval into:

- `queueWaitMs`: time waiting to enter the writer lane.
- `writerExecutionMs`: the owning callback's duration, including asynchronous waits.
- `completionDelayMs`: time between callback completion and the caller resuming.

These fields are available when the queued callback started and finished;
`elapsedMs` records the total duration. The warning's console line carries the
same fields as `key=value` pairs; `openclaw logs --json` shows the original `raw` record.

Use `operation` to locate the owning code path. It does not identify a specific
SQL statement, measure CPU time or lock contention, or establish that a nearby
RPC caused the delay. Older records may lack `operation`; do not infer it from
adjacent log messages.

`session.reclamation.worker-commit` labels every numbered Worker write admission,
not only its final commit. `reclamationAdmissionId` is the actual request ID,
scoped to that Worker and process. `reclamationAdmissionReleaseCause` records the
observed `worker-release` message or `worker-exit` event. It does not infer an
initial/final phase or prove successful commit or cleanup. An early failure can
leave the release cause absent because neither event has been observed yet.

For `session.lifecycle.artifacts-prepare`, the same warning includes a bounded
`artifactPreparation` object. `admissionMode` distinguishes an existing cached
handle from asynchronous acquisition; `admissionMs` stops when the planner
receives that handle. Asynchronous acquisition may include shared admission and
integrity-check waits, so it is not a CPU measurement.

The remaining millisecond fields separate node inventory and selection
(`nodeInventoryMs`), references and entry deletion plans (`referencePlanningMs`),
orphan selection and plans (`orphanPlanningMs`), and transcript marker iteration
(`markerScanMs`). Orphan planning excludes marker time. Counts report existing
node/window rows before agent or prefix filtering, referenced IDs, selected entries, entered marker queries,
consumed marker rows, and deletion plans. They are observed result counts, not
SQLite internal row visits. No identifiers, marker text, transcript contents, or
byte counts are added. `completed: false` marks partial observations when
preparation failed; absent fields were not completed. These fields do not change
the warning threshold or prove that a nearby request caused the work. Rounding
and work outside the measured subphases can leave a difference from
`writerExecutionMs`; do not assign that remainder to a specific phase.

For `session.history.archive-prune`, the same slow or failure warning can include
one bounded `archivePruning` object. Its `trigger` is recorded at the call site:
`initial`, `after-eviction`, or `final`. It distinguishes pruning passes within
the maintenance flow; it does not identify the request that caused maintenance.

The object aggregates observations across the pruning pass:

- `admissionMs`, `cachedAdmissions`, and `asyncAdmissions` measure database
  acquisition and count its observed modes. Admission time ends at callback entry
  or acquisition failure and can include shared admission and integrity-check waits.
  A refusal before mode selection adds admission time without incrementing either mode count.
- `checkpointMs`, `checkpointMaxMs`, and `checkpointCalls` report total time,
  longest call, and calls entered. `checkpointIncomplete` counts calls returning
  false, which can mean a busy checkpoint or an error; it does not identify a lock
  holder or distinguish those outcomes. A thrown checkpoint contributes to call
  count and time without incrementing `checkpointIncomplete`.
- `vacuumMs`, `vacuumPasses`, and `vacuumPagesRequested` measure incremental vacuum
  calls and their requested page counts. Requested pages are not confirmed
  reclaimed pages.
- `queryMs` covers existing archive-presence, candidate, unpublished-name, and
  freelist reads. `rowDeletionMs` covers the canonical archive row-deletion
  transaction.
- `fileRemovalMs`, `removedFiles`, `missingFiles`, and `failedRemovals` report
  existing file-removal outcomes. `removedFiles` counts successful canonical and
  legacy removals. `missingFiles` counts canonical removal attempts that return
  `ENOENT`. Other canonical failures and all unsuccessful legacy removals count
  under `failedRemovals`; the legacy count includes missing paths, non-files,
  and stat or removal failures.
- `measurementMs` and `measurements` cover awaited disk-usage measurement attempts,
  including failures and time queued for the measurement Worker, scanning, and
  returning the result. `legacyInventoryMs` covers legacy file inventory,
  filtering, and sorting.

All durations are wall time, including asynchronous waits, rather than CPU
measurements. `completed: false` retains partial observations when pruning
throws; an absent stage timing field means that stage was not entered.
`completed: true` means the pruning pass returned normally. It does not prove
that every checkpoint completed, every removal succeeded, or the high-water
target was reached. Rounding and unmeasured work can leave a remainder relative
to `writerExecutionMs`; `checkpointMaxMs` is already included in `checkpointMs`.

These fields reuse existing operations without additional store reads, per-file
records, paths, names, or content. They do not change the warning threshold,
checkpoint mode or timeout, or archive-retention behavior.

### Slow reply preparation

When a reply spends a long time preparing, inspect the normal Gateway logs:

```bash
openclaw logs --follow --plain | rg 'timings|agent turn milestone|liveness warning'
```

Reply resolver, dispatch, and agent-turn preparation milestones include stage
durations, elapsed time, and available run/session identifiers. Without profiler
flags, they warn at 10 seconds elapsed or 5 seconds in one preparation stage. Codex preparation also
logs each completed slow stage immediately, including failures, and emits a
`native-turn-handoff` summary before submitting the native turn. Timing records
contain stage names and identifiers, not prompts or tool arguments.

Embedded-run startup, prep, core-plugin-tool and auth stage summaries include
`pid`, `threadId` and `isMainThread` in the message to distinguish emitters sharing
a log file. These identify the summary emitter, not where every timed operation
ran. Elapsed stage time can include asynchronous waits and is not CPU time.

Use the first `turn_accepted`, `model_call_started`, `tool_execution_started`, and
`assistant_output_started` milestones to separate startup from later activity.
Delayed first assistant/tool activity is logged once at `info` by default,
because provider and tool latency is not itself a preparation warning.
These are runtime observations: native turn acceptance does not prove that a
provider request has started. Whole-turn summaries remain profiler-only because
their totals include model and tool time. Compare the individual preparation
stages before attributing a long turn to Gateway startup. A simultaneous
`liveness warning` with high event-loop delay
can explain delays across several sessions.

For shorter delays, [profiler flags](/diagnostics/flags#profiler-flags) lower the
warning thresholds. They are not required to diagnose a multi-second startup
stall.

### Model call size and timing

Model-call diagnostics record bounded request/response measurements without
capturing raw prompt or response content:

- `requestPayloadBytes`: UTF-8 byte size of the final model request payload
- `responseStreamBytes`: UTF-8 byte size of streamed model response chunk
  payloads. High-frequency text, thinking, and tool-call delta events count
  only the incremental `delta` bytes instead of full `partial` snapshots.
- `timeToFirstByteMs`: elapsed time before the first streamed response event
- `durationMs`: total model-call duration

These fields are available to diagnostic snapshots, model-call plugin hooks, and
OTEL model-call spans/metrics when diagnostics export is enabled.

### Console styles

`logging.consoleStyle` accepts `pretty` or `json`:

- `pretty`: human-friendly, colored, with timestamps.
- `json`: JSON per line (for log processors).

A third rendering style, `compact` (tighter output, best for long sessions), is
applied automatically when stdout is not a TTY. It is no longer a settable
config value; `openclaw doctor --fix` maps a stored `consoleStyle: "compact"`
to `"pretty"`.

### Redaction

OpenClaw can redact sensitive tokens before they hit console output, file logs,
OTLP log records, persisted session transcript text, or Control UI tool
event payloads (tool start args, partial/final result payloads, derived
exec output, and patch summaries):

- Sensitive-value redaction is always enabled.
- `logging.redactPatterns`: list of regex strings that replaces the default string list for log/transcript output. Built-in structural protections for form bodies, structured authorization headers, and bare AWS secret access keys always apply, including when this list is copied or customized. For Control UI tool payloads, custom patterns apply on top of the built-in defaults, so adding a pattern never weakens redaction of values already caught by the defaults.

File logs use JSONL; active session transcripts live in the
[per-agent SQLite database](/reference/database-schemas#database-layout). Matching
secret values are masked before the line or message is persisted. Redaction is best-effort:
it applies to text-bearing message content and log strings, not every
identifier or binary payload field.

Transcript redaction does not replace the live arguments used to execute tools.
Canonical assistant tool-call IDs and matching tool-result IDs remain unchanged
so stored history can correlate with live tool events. This exemption applies
only to protocol metadata; the same values in arguments, results, or nested
payloads still pass through redaction.

In the OpenClaw harness, finalized tool-result text is masked after middleware,
before entering live model context. This also covers exec output and tool errors;
it preserves media bytes and the original arguments used to execute tools.
Redaction happens when the result is added, keeping later prompt replay stable.
Model-visible tool-result text uses narrower assignment matching so source code
remains intact. Registered secrets and explicit credential forms, including
structured fields, authorization headers, URL credentials, and known token
formats, remain masked. Direct reads of `.env` files apply
broader assignment masking before their content becomes a tool result. Other
config and source reads preserve opaque values; register actual secrets instead
of relying on key-name matching. Bare source assignments such as
`token = timeObserverToken` remain unchanged.

The built-in defaults cover common API credentials and payment-credential field
names such as card number, CVC/CVV, shared payment token, and payment credential
when they appear as JSON fields, URL parameters, CLI flags, or assignments.

OpenClaw also redacts safety-boundary payloads shown to UI clients, support
bundles, diagnostics observers, approval prompts, or agent tools. Custom
`logging.redactPatterns` can add project-specific patterns on those surfaces.

## Diagnostics and OpenTelemetry

Diagnostics are structured, machine-readable events for model runs and
message-flow telemetry (webhooks, queueing, session state). They do **not**
replace logs — they feed metrics, traces, and exporters. Events are emitted
in-process by default (set `diagnostics.enabled: false` to turn them off);
exporting them is separate.

When a session directive rejects a turn before model execution, its existing
`message.processed` event reports `outcome: "skipped"` with a closed `reason`
code and the usual channel, message, and session correlation. The rejection
does not add the user's message, model token, or error reply to that event.

Two adjacent surfaces:

- **OpenTelemetry export** — send metrics, traces, and logs over OTLP/HTTP to
  any OpenTelemetry-compatible collector or backend (Datadog, Grafana,
  Honeycomb, New Relic, Tempo, etc.). Full configuration, signal catalog,
  metric/span names, env vars, and privacy model live on a dedicated page:
  [OpenTelemetry export](/gateway/opentelemetry).
- **Diagnostics flags** — targeted debug-log flags that route extra logs to
  `logging.file` without raising `logging.level`. Flags are case-insensitive
  and support wildcards (`telegram.*`, `*`). Configure under `diagnostics.flags`
  or via the `OPENCLAW_DIAGNOSTICS=...` env override. Full guide:
  [Diagnostics flags](/diagnostics/flags).

For OTLP export to a collector, see [OpenTelemetry export](/gateway/opentelemetry).

## Troubleshooting tips

- **Gateway not reachable?** Run `openclaw doctor` first.
- **Logs empty?** Check that the Gateway is running and writing to the file path
  in `logging.file`.
- **Need more detail?** Set `logging.level` to `debug` or `trace` and retry.

## Related

- [OpenTelemetry export](/gateway/opentelemetry) — OTLP/HTTP export, metric/span catalog, privacy model
- [Diagnostics flags](/diagnostics/flags) — targeted debug-log flags
- [Gateway logging internals](/gateway/logging) — WS log styles, subsystem prefixes, and console capture
- [Configuration reference](/gateway/config-observability#diagnostics) — full `diagnostics.*` field reference
- [`openclaw logs`](/cli/logs) — tail Gateway logs over RPC from the CLI
