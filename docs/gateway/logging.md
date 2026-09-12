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
agent model: openai/gpt-5.6-sol (thinking=medium, fast=on)
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

Talk, realtime voice, and managed-room code paths use the shared file logger for bounded lifecycle records intended for operational debugging and OTLP log export. Transcript text, audio payloads, turn ids, call ids, and provider item ids are never copied into the log record.

The Control UI Logs tab tails this file via the gateway (`logs.tail`). The CLI does the same:

```bash
openclaw logs --follow
```

If a tail read observes that the active file has disappeared, the Control UI clears its previous records and follows the recreated file. Missing files still return an empty tail; filesystem read errors remain visible.

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
filtering and delivery previews outside that page are not included. Existing
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
`scopeAttemptCount` is zero for direct lists. Scoped lists allow
three total attempts. For scoped lists, `scopeProcessingMs` is listing time
minus source-page time: it includes visibility filtering, snapshot processing
and scheduling between page calls. These components are already included in
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

Model-visible tool-result text preserves ambiguous source assignments such as
`token = timeObserverToken`. Registered secrets and explicit credential forms,
including structured fields, authorization headers, URL credentials, and known
token formats, remain masked. Direct reads of `.env`
files apply broader assignment masking before their content becomes a tool
result. Other config and source reads preserve opaque values. Register actual
secrets instead of relying on key-name matching. Other transcript fields and
diagnostic sinks retain broad assignment matching.

- Sensitive-value redaction is always enabled.
- `logging.redactPatterns`: array of regex strings (overrides defaults)
  - Use raw regex strings (auto `gi`), or `/pattern/flags` for custom flags.
  - Matches are masked keeping the first 6 + last 4 chars (values >= 18 chars). Shorter values become `***`.
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, popular vendor token prefixes, and payment credential field names (card number, CVC/CVV, shared payment token, payment credential).

Safety boundaries such as Control UI tool-call events, `sessions_history` output, diagnostics exports, provider errors, exec approval display, and Gateway WebSocket logs always redact. `logging.redactPatterns` adds deployment-specific patterns.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only "interesting" RPC results print - errors (`ok=false`), slow calls (default threshold: `>= 50ms`), and parse errors.
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

With `diagnostics.enabled: true` and warning logging enabled, `sessions.list`
handlers taking at least one second also emit `slow session list`. The record
includes process/thread identity, the request trace, and `cacheRole`: a completed
cache hit, an in-flight follower, a projection owner, or `unreached` if the handler
failed before selecting a cache path. Followers can include `workTraceId` and
`workSpanId` to identify the request producing their shared result. Successful
list results report `selectedRowCount` for every cache role.

Projection owners report phase totals, visibility-repair counts, synchronous
preparation/row time, and `yieldWaitMs`/`yieldCount` for time spent awaiting the
event loop. Hits and followers omit those projection counters. `rows` includes
its synchronous and yielded intervals; do not add those details to the phase
total again. `handlerElapsedMs` starts before parameter validation and excludes
admission before the handler. The `response` phase includes the synchronous response callback. These are elapsed
durations, not CPU time or proof of client receipt. No query text or session
contents are included.

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
