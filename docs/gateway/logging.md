---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: "Gateway logging"
---

<a id="logging" />

For a user-facing overview (CLI + Control UI + config), see [/logging](/logging).

OpenClaw has two log surfaces:

- **Console output** - what you see in the terminal.
- **File logs** - JSON lines written by the gateway logger.

At startup, the Gateway logs the resolved default agent model plus the mode defaults that affect new sessions:

```text
agent model: openai/gpt-6-astra (thinking=medium, fast=on)
```

`thinking` comes from the default agent, model params, or the global agent default. When unset it shows `medium`. `fast` comes from the default agent or the model's `fastMode` params.

If a plugin reload supersedes startup plugin loading, the model line, loaded-plugin summary, and channel warnings use the replacement configuration and plugin metadata.

## File-based logger

- Default rolling log files are under `/tmp/openclaw/` (one file per day), dated by the gateway host's local timezone. The default profile uses `openclaw-YYYY-MM-DD.log`. Named profiles use `openclaw-<profile>-YYYY-MM-DD.log` (for example, `openclaw-dev-YYYY-MM-DD.log`). If that directory is unsafe or unwritable (wrong owner, world-writable, a symlink), OpenClaw falls back to a user-scoped `os.tmpdir()/openclaw-<uid>` path instead. On Windows it always uses that OS-tmpdir fallback.
- Active log files rotate at `logging.maxFileBytes` (default: 100 MB). Rotation keeps up to five numbered archives (`.1` through `.5`), and continues to write a fresh active file.
- Configure the log file path and level via `~/.openclaw/openclaw.json`: `logging.file`, `logging.level`.
- The file format is one JSON object per line.

With config hot reload enabled, changes to `logging.level`, `logging.file`, and
`logging.maxFileBytes` apply to the next log record, including records from
long-lived channel loggers. Queued records finish writing to their original file.
Explicit logger-level overrides, such as Baileys verbosity, remain in effect.

Subsystem file logs omit call-site metadata (`_meta.path`) for `trace`, `debug`,
`info`, and `warn` records, including `raw()` lines, to avoid capturing and parsing
a stack on every routine message. `error` and `fatal` records retain it. All levels
retain call-site metadata while diagnostics are enabled and an internal log-record
consumer is subscribed, preserving [OTLP code locations](/gateway/opentelemetry/privacy-and-trace-context).
This follows diagnostic enablement and subscriptions on the next record, including
for existing subsystem loggers. Log messages, structured fields, and error stacks
supplied by callers are unchanged.

Talk, realtime voice, and managed-room code paths use the shared file logger for bounded lifecycle records intended for operational debugging and OTLP log export. Transcript text, audio payloads, turn ids, call ids, and provider item ids are never copied into the log record.

Discord realtime voice keeps session lifecycle transitions at `info`; audio chunks
and transcript deltas use `debug`. Model-fetch starts and successful responses
under one second also use `debug`. Non-2xx responses and responses taking at least
one second remain at `info`; transport failures remain warnings. The existing
[model transport diagnostic flags](/logging#targeted-model-transport-diagnostics)
promote transport details to `info` when enabled.

Secret egress request audit records remain at `info`, including successful
forwarding. Their structured fields record the proxy outcome without request
payloads or credentials; see [secret egress proxy](/gateway/secrets/secret-store-and-egress#secret-egress-proxy).

The Control UI Logs tab tails this file via the gateway (`logs.tail`). The CLI does the same:

```bash
openclaw logs --follow
```

If a tail read observes that the active file has disappeared, the Control UI clears its previous records and follows the recreated file. Missing files still return an empty tail. Filesystem read errors, including a log path that points to a directory, remain visible while the Control UI keeps the last successfully read records as stale data.

### Verbose vs. log levels

- **File logs** are controlled exclusively by `logging.level`.
- `--verbose` only affects **console verbosity** (and WS log style) - it does **not** raise the file log level.
- To capture verbose-only details in file logs, set `logging.level` to `debug` or `trace`.
- Embedded-run `continue_normal` decisions log at `debug`. Retry, profile-rotation, model-fallback, and error decisions remain warnings.
- Trace logging also includes diagnostic timing summaries for selected hot paths, such as plugin tool factory preparation. See [/tools/plugin#slow-plugin-tool-setup](/tools/plugin#slow-plugin-tool-setup).

### SQLite session writes

Failed SQLite session writes include a bounded, redacted `error` summary in
their structured file-log record, with cause and error-code details when
available. Long summaries are truncated. The record retains its write timing
and store fields.

### SQLite snapshot cleanup

Failed removal of a temporary read-only SQLite snapshot is recorded once by its
cleanup owner in the structured file log, with the owned path, removal operation,
and filesystem error code when available. These diagnostics do not write to
subprocess stdout or stderr, so a successful read keeps its result and a failed
update retains its original error detail. Existing required-cleanup failures
remain errors.

### Slow agent database opens

A completed physical agent-database open taking at least one second emits
`slow OpenClaw agent database open`. The record retains total elapsed time and
the `open`, `validation`, `configuration`, `schema`, and `registration` phases.
For a yielded integrity check, it also includes `integrityGateMs` and
`integrityGateOutcome` (`healthy` or `failed`). The gate includes the check plus
any driver waits, scheduling, and ownership revalidation. When admission uses a
separate integrity Worker, its lifetime is included. This does not isolate
native-check or CPU time.

When canonical-index validation completes, `canonicalIndexMs` reports the
subsequent synchronous inspection and any repair or rechecks, and
`repairedIndexCount` counts indexes successfully repaired by that operation.
A healthy initial integrity check can still require an index-definition repair.
A failed initial check can be recovered by a successful repair. Fields are
absent when their stage does not run, including the yielded-check fields for a
fresh empty database. These details cover portions of `validation`, not extra
time to add to it. The summary is emitted only at registration. Earlier failures
and live cache hits produce no summary. The details add no index names or
database contents.

### Slow cron list pages

A cron list page taking at least one second emits `cron: slow list page` through
its existing logger, subject to the file log level. The structured record names
`operation: "cron.listPage"` and reports `elapsedMs`, `waitToCallbackMs`,
`callbackMs`, and `completionDelayMs`, plus available source, matched, and returned
row counts, the outcome, and emitter `pid`, `threadId`, and `isMainThread`. Fast
pages emit no such record.

These are wall times, not CPU time: waiting includes scheduling delays, callback
time includes awaited work, and completion delay covers settlement after the
callback finishes. Each source page is measured separately. Caller visibility
filtering runs inside the page callback; delivery previews remain outside it. Existing
trace context is retained when present. Emitter identity identifies the logging process/isolate, not the owner of work
awaited by the callback. The diagnostic adds no job identifiers,
job contents, or request parameters.

### Slow cron list requests

With `diagnostics.enabled` active, a `cron.list` handler taking at least one
second emits `cron: slow list request` through the Gateway logger. The record
uses the existing request trace/span and reports `elapsedMs` plus fixed
`phaseDurationsMs` for `setup`, `listing`, `projection`, optional `previews`,
`response`, and `handlerExit`. Unentered phases are absent.

`sourcePageMs` and `sourcePageCount` aggregate source-page calls, including
failed calls. `returnedCount` appears once a page is selected.
`scopeAttemptCount` is zero for direct lists and one for scoped lists. Visibility
filtering, sorting, revision calculation, and pagination share one locked source
operation. For scoped lists, `scopeProcessingMs` is listing time minus source-page
time, covering work outside that operation. These components are already included in
the listing phase and must not be added to it again.

The bounded branch fields are `compact`, `previewsRequested`, and `scopeApplied`.
`previewsRequested` describes the selected response mode, not whether execution
reached that phase. `handlerOutcome` is `returned` or `threw`. `responseOutcome`
is `none`, `ok`, `error`, or `threw` for the handler's response callback. Its
`response` phase measures that synchronous callback, and `handlerExit` ends at
the handler's own cleanup boundary. Neither proves socket delivery or client
receipt. Outer RPC diagnostics retain those separate outcomes.

All durations are wall time, including awaits and scheduling, not CPU time.
Fast requests and requests with diagnostics disabled emit no summary. The
record adds no job identifiers, content, query strings, targets or error text,
and does not change individual slow-page warnings or response payloads.

### Slow Codex catalog pages

With diagnostics and warning logging enabled, a Codex catalog page taking at
least one second emits `slow Codex catalog page producer`. Its existing phase
totals distinguish client acquisition, request waiting, and page processing.
`diagnosticEpoch` and `operationId` identify the page observation;
`listOperationId` links its originating logical list when available.

`controlWaitersV1` is a JSON-encoded array joining sampled page waits to the
physical client and JSON-RPC attempt. Decode the string with `JSON.parse` to
read its tuples. It keeps the first two and latest two completed waiter summaries.
`controlWaitersOmitted` counts summaries excluded by the bounds. Each entry has
these positions:

| Index | Meaning                                                       |
| ----: | ------------------------------------------------------------- |
|     0 | Control request ordinal within the page                       |
|     1 | Overload attempt ordinal within that control request          |
|     2 | Physical client instance UUID                                 |
|     3 | JSON-RPC request id                                           |
|     4 | Waiter ordinal within that wire attempt                       |
|     5 | `new` or `joined` attempt                                     |
|     6 | Attempt creation time                                         |
|     7 | First possible write time, or `null` before any write attempt |
|     8 | Waiter attachment time                                        |
|     9 | Waiter settlement time                                        |
|    10 | Waiter outcome                                                |
|    11 | Wire outcome observed when the waiter settled                 |
|    12 | Wire outcome observation time, or `null` while pending        |

Times are rounded process-local monotonic milliseconds, comparable within the
same process. A later waiter retains the original attempt and possible-write
times. Waiter outcomes distinguish `resolved`, `native-error`, `timed-out`,
`aborted`, `authority-rejected`, `local-failed`, and `client-closed`. Wire outcomes
are `retained-pending`, `native-ok`, `native-error`, `ingress-rejected`,
`correlation-closed`, or `not-written`.

A possible write does not prove native acceptance. A joined waiter does not
mean another request was sent, and a timed-out waiter can leave the wire attempt
pending. Later wire settlement is not promised after the page observation closes.
These records contain no query, cursor, path, title, authentication data, or raw
error. Existing bounds remain 64 active observations, 60 warnings per minute,
28 metadata keys, and 2,048 bytes. Missing or omitted summaries are unavailable
evidence, not zero activity; durations do not attribute native CPU or client receipt.

## Console capture

The CLI captures `console.log/info/warn/error/debug/trace`, writes them to file logs, and still prints to stdout/stderr.

`console.trace()` keeps its redacted stack in every console style, including
forced stderr output. File capture records it once at `trace` level, subject to
the configured file log level.

Tune console verbosity independently:

- `logging.consoleLevel` (default `info`)
- `logging.consoleStyle` (`pretty` | `json`). When unset, output is `pretty` on a TTY and the automatic `compact` style otherwise. `compact` is no longer a settable value. `openclaw doctor --fix` maps a stored one to `pretty`.

## Redaction

OpenClaw masks sensitive tokens before log or transcript output leaves the process. This redaction policy applies at console, file-log, OTLP log-record, and session transcript text sinks. Matching secret values are masked before JSONL lines or messages are written to disk.

The OpenClaw harness masks finalized tool-result text after middleware, before
it enters live model context, including exec output and tool errors. Media bytes
and the original execution arguments stay intact; later replay reuses the masked
result. Model-visible tool-result text preserves ambiguous source assignments such as
`token = timeObserverToken`. Registered secrets and explicit credential forms,
including structured fields, authorization headers, URL credentials, and known
token formats, remain masked. Direct reads of `.env`
files apply broader assignment masking before their content becomes a tool
result. Other config and source reads preserve opaque values. Register actual
secrets instead of relying on key-name matching. Other transcript fields and
diagnostic sinks retain broad assignment matching.

- Sensitive-value redaction is always enabled.
- `logging.redactPatterns`: array of regex strings (replaces the default string list). Built-in structural protections for form bodies, structured authorization headers, and bare AWS secret access keys always apply.
  - Use raw regex strings (auto `gi`), or `/pattern/flags` for custom flags.
  - Matches are masked keeping the first 6 + last 4 chars (values >= 18 chars). Shorter values become `***`.
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, popular vendor token prefixes, and payment credential field names (card number, CVC/CVV, shared payment token, payment credential).

File and JSON console records finish masking before final JSON encoding. Rules run in order over decoded values, then serialized record context, with later rules seeing earlier masks. String matches retain their existing token hints so later rules can match those hints. Structured credential fields use full masks; matched numbers, booleans, and null become the JSON string `"***"`. File records retain built-in credential patterns when custom patterns are configured.

Safety boundaries such as Control UI tool-call events, `sessions_history` output, formatted health failures, Doctor Gateway connection notes, diagnostics exports, provider errors, exec approval display, and Gateway WebSocket logs always redact. `logging.redactPatterns` adds deployment-specific patterns.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only "interesting" RPC results print - errors (`ok=false`), slow calls (default threshold: `>= 50ms`), and parse errors.
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

With `diagnostics.enabled: true` and warning logging enabled, `sessions.list`
handlers and `sessions.subscribe` snapshot handlers taking at least one second
also emit `slow session list`. The `operation` field identifies which request
produced the record. The record
includes process/thread identity, the request trace, and row counts:
`selectedRowCount`, `dirtyRowCount`, `materializedRowCount`, and `reusedRowCount`.
The latter two distinguish selected rows refreshed during this request from
selected rows already resident when it began. Dirty counts describe pending
owner work at the start of the request.

The `materialize` phase measures the wait for session-row projection readiness. In-flight
catalog renewals no longer block lists or descriptions once a catalog is loaded:
reads use the current catalog while its replacement loads in the background, then
rows refresh with the new catalog. Startup still waits for the first catalog.
Renewals that retain identical catalog content do not dirty resident rows.

Profile and run-registry publications refresh their derived display facts without
rereading session entries. Worker environment and placement publications refresh
only the selected rows' worker facts on their next presentation. Stored session
writes publish exact keys; broad list notifications do not schedule an all-row
drain. Config, store topology, and adopted model catalogs still refresh affected
live rows before lists respond. Archived rows stay cold until selected.

Transcript-only row refreshes use a one-second window per resident session: the
first notification refreshes promptly, and further notifications collapse into a
trailing refresh. These pending notifications are not dirty rows until that
refresh is due. Transcript freshness can therefore lag by up to one window;
optional previews still wait for idle background backfill. Metadata, lifecycle,
catalog, and topology publications continue to invalidate immediately.
Transcript notifications do not invalidate parents or children: relationships,
inherited model settings, and subagent activity have their own metadata or
registry publications.

Records report phase totals, synchronous selection/row time, and
`yieldWaitMs`/`yieldCount` for awaiting shared projection readiness. These waits
can include coalesced work shared with other callers. Phase totals include their
wait intervals; do not add the detailed counters to those totals again.
`handlerElapsedMs` starts before parameter validation and excludes
admission before the handler. The `response` phase includes the synchronous response callback. These are elapsed
durations, not CPU time or proof of client receipt. No query text or session
contents are included.

The same record includes fractional-millisecond current-thread CPU measurements
for synchronous work: `prepareThreadCpuMs`, `rowThreadCpuMs`, and
`responseThreadCpuMs`. Preparation covers resident selection, filtering, and
sorting after projection readiness. Row CPU includes presentation and final list
construction. Both intervals finish before the response callback is measured;
response CPU excludes network waits. Measurements finish before this diagnostic
record is published or logged. Projection readiness waits, background
materialization, intervening microtasks, and worker CPU are not included.
These are selected inclusive CPU intervals, including same-thread native work and
garbage collection, not SQL-only CPU or a complete request CPU total.

Unvisited measurements are omitted. Each request retains its own selection,
presentation, and response CPU without inheriting shared background work.
If a CPU counter read fails, all CPU fields are omitted for that request;
its result and elapsed diagnostics are preserved. Existing activation and the
one-second warning threshold are unchanged, so missing slow records do not account
for CPU consumed by faster requests.

Catalog lists additionally expose fixed request-stage observations through the
existing diagnostic event stream and [Prometheus exporter](/gateway/prometheus#catalog-list-stages).
These include initial/final projection readiness, provider or coalesced waits,
and synchronous planning/final-delivery thread CPU. Unlike slow logs, these
observations include requests below one second when an interested trusted
consumer is active. They do not change warning thresholds, startup-phase history,
request behavior or diagnostic collection settings.

### WS log style

`openclaw gateway` supports a per-gateway style switch:

- `--ws-log auto` (default): normal mode is optimized. Verbose mode uses compact output.
- `--ws-log compact`: compact output (paired request/response) when verbose.
- `--ws-log full`: full per-frame output when verbose.
- `--compact`: alias for `--ws-log compact`.

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

The console formatter is **TTY-aware** and prints consistent, prefixed lines. Subsystem loggers keep output grouped and scannable:

- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`).
- **Subsystem colors** (stable per subsystem, hashed from the name) plus level coloring.
- **Color when output is a TTY** or the environment looks like a rich terminal (`TERM`/`COLORTERM`/`TERM_PROGRAM`). Respects `NO_COLOR` and `FORCE_COLOR`.
- **Shortened subsystem prefixes**: drops a leading `gateway/`, `channels/`, or `providers/` segment, then keeps at most the last 2 remaining segments (e.g. `channels/turn/execution` displays as `turn/execution`). Known channel subsystems (`telegram`, `whatsapp`, `slack`, etc.) always collapse to just the channel name.
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`).
- **`logRaw()`** for QR/UX output (no prefix, no formatting).
- **Console styles**: `pretty` | `json` (`compact` is applied automatically off-TTY and is not a settable value).
- **Console log level** is separate from file log level (file keeps full detail when `logging.level` is `debug`/`trace`).
- **WhatsApp message bodies** log at `debug` (use `--verbose` to see them).

This keeps file logs stable while making interactive output scannable.

## Related

- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry)
- [Diagnostics export](/gateway/diagnostics)
- [`openclaw logs`](/cli/logs) — tail Gateway logs over RPC from the CLI
