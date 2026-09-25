---
summary: "Create shareable Gateway diagnostics bundles for bug reports"
title: "Diagnostics export"
read_when:
  - Preparing a bug report or support request
  - Debugging Gateway crashes, restarts, memory pressure, or oversized payloads
  - Reviewing what diagnostics data is recorded or redacted
---

OpenClaw can build a local diagnostics `.zip` for bug reports: sanitized Gateway
status, health, logs, config shape, and recent payload-free stability events.

Treat diagnostics bundles like secrets until reviewed. Payloads and credentials
are redacted by design, but the bundle still summarizes local Gateway logs and
host-level runtime state.

## Quick start

```bash
openclaw gateway diagnostics export
```

Prints the written zip path. Choose an output path:

```bash
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
```

For automation:

```bash
openclaw gateway diagnostics export --json
```

## Chat command

Owners can run `/diagnostics [note]` in any conversation to request a local
Gateway export as one copy-pasteable support report:

1. Send `/diagnostics`, optionally with a short note (`/diagnostics bad tool choice`).
2. OpenClaw sends a preamble and asks for one explicit exec approval, which runs
   `openclaw gateway diagnostics export --json`. Do not approve diagnostics via
   an allow-all rule.
3. After approval, OpenClaw replies with the local bundle path, manifest
   summary, privacy notes, and relevant session ids.

In group chats, an owner can still run `/diagnostics`, but OpenClaw sends the
export result, approval prompts, and Codex session/thread breakdown to the
owner privately. The group sees only a short status notice: approval pending,
private delivery confirmed, delivery pending, or delivery suppressed. Pending
delivery does not trigger another private send. If no private owner route exists,
the command asks the owner to run it from a DM.

When the active session uses the native OpenAI Codex harness, the same exec
approval also covers an OpenAI feedback upload for the Codex threads OpenClaw
knows about. That upload is separate from the local Gateway zip and only
happens for Codex harness sessions. The approval prompt states that approving
also sends Codex feedback, without listing Codex session or thread ids. After
approval, the reply lists channels, OpenClaw session ids, Codex thread ids, and
local resume commands for the threads that were sent to OpenAI. Denying or
ignoring the approval skips the export, the Codex feedback upload, and the
Codex id list.

That makes the Codex debugging loop short: notice bad behavior in a channel,
run `/diagnostics`, approve once, share the report, then run the printed
`codex resume <thread-id>` command locally if you want to inspect the thread
yourself. See [Codex harness](/plugins/codex-harness/commands#inspect-codex-threads-locally).

## What the export contains

- `summary.md`: human-readable overview for support.
- `diagnostics.json`: machine-readable summary of config, logs, status, health,
  and stability data.
- `manifest.json`: export metadata and file list.
- Sanitized config shape and non-secret config details.
- Sanitized log summaries and recent redacted log lines.
- Best-effort Gateway status and health snapshots.
- `stability/latest.json`: newest persisted stability bundle, when available.

The export is still useful when the Gateway is unhealthy: if status/health
requests fail, local logs, config shape, and the latest stability bundle are
still collected when available.

## Privacy model

Kept: subsystem names, plugin ids, provider ids, channel ids, configured
modes, status codes, durations, byte counts, queue state, memory readings,
sanitized log metadata, redacted operational messages, config shape, and
non-secret feature settings.

Omitted or redacted: chat text, prompts, instructions, webhook bodies, tool
outputs, credentials, API keys, tokens, cookies, secret values, raw
request/response bodies, account ids, message ids, raw session ids,
hostnames, and local usernames.

When a log message looks like user, chat, prompt, or tool payload text, the
export keeps only that a message was omitted plus its byte count.

## WebSocket disconnect logs

Connected webchat and authenticated-user disconnects include `durationMs`
(connection lifetime in milliseconds) in default info-level file logs. The
`cause` field contains the Gateway's recorded close cause, when known; otherwise
it is omitted. `heartbeat-timeout` records the Gateway's missed-pong decision.
It does not prove that a ping reached the remote peer or that the peer caused
the transport failure.

Heartbeat-timeout records also capture these facts before termination:

- `pingWriteState`: `pending` when no write callback has been observed,
  `completed` after local write completion, or `failed` after a write error.
  Pending does not prove the ping was unsent; completed does not prove peer receipt.
- `lastPongAgeMs`: monotonic elapsed milliseconds since the last observed pong,
  omitted when no pong has been observed.
- `bufferedBytes`: aggregate local WebSocket buffering at the timeout decision,
  not the delivery status of an individual ping.

## Stability recorder

The Gateway records a bounded, payload-free stability stream by default when
diagnostics are enabled. It captures operational facts, not content.

The same heartbeat also samples liveness when the event loop or CPU looks
saturated, emitting `diagnostic.liveness.warning` events with event-loop delay,
event-loop utilization, CPU-core ratio, active/waiting/queued session counts,
the current startup/runtime phase (when known), recent phase spans, and
bounded work labels. These become Gateway `warn`-level log lines when
work is waiting or queued, when active work overlaps sustained event-loop
delay, or when the Gateway reports at least 60 seconds of persistent degradation;
otherwise they log at `debug`. Persistent Gateway degradation can warn even when
no tracked work is active. Other idle liveness samples remain diagnostic events
without escalating to a warning.

Startup phases emit `diagnostic.phase.completed` events with wall-clock and
whole-process CPU timing, including worker and native threads. Phase CPU can
include concurrent work outside that phase; it is not exclusive attribution.
The `cpuCoreRatio` in phase and liveness events is measured in core equivalents
and can exceed `1`. See
[CPU pressure and event-loop delay](/gateway/health#cpu-pressure-and-event-loop-delay).

With diagnostics enabled, `sessions.patch` and `sessions.patchMany` calls lasting
at least one second add an info-level `slow session patch` file-log record. Its
`elapsedMs`, `phaseDurationsMs`, and `phaseCounts` distinguish lifecycle admission,
snapshot reads, catalog preparation, projection, commit, runtime acknowledgements,
effects, and response work. Records inherit the request's diagnostic trace when
available and contain fixed phase names and numbers, not patch values or session
keys. Repeated stage visits contribute to the counts and totals. Parallel and
nested stages can overlap, so their totals are neither an exclusive breakdown
of request time nor CPU measurements.

Two related info-level records help attribute slow worktree cleanup:
`slow managed worktree removal` separates allocation admission, callback work,
and final settlement, with preparation, snapshot, checkout removal, and body
finalization timings inside the callback; `slow Git ref mutation` separates directory resolution,
queue waiting, and queued work. Both require diagnostics and info-level logging,
emit only after an operation lasting at least one second settles, and have
separate fixed budgets of 60 records per minute per runtime isolate with
`omittedObservations` counts. They retain fixed scalar fields and existing traces,
without adding private paths or new identities. Their elapsed intervals can nest
inside `worktreeCleanup` and include asynchronous waits; they are not CPU or
individual child-command timings. See [Slow worktree cleanup](/logging#slow-worktree-cleanup)
for fields and missing-record limits.

SQLite session-write warnings also separate `queueWaitMs`, `writerExecutionMs`,
and `completionDelayMs`. These measure time until the writer starts, work and
awaits inside the writer lane, and time until its caller resumes after execution.
Writer execution is not SQLite transaction-lock hold time; native transaction
lock-wait and hold warnings remain separate. Writes rejected before entering the
writer omit these three fields. This breakdown is in
file logs, not the aggregate Gateway RPC Prometheus histograms.

These warnings include the writer's `pid`, Node `threadId`, and `isMainThread`.
Reclamation callbacks also record their `reclamationKind` and, when a Worker was
created, its captured `workerThreadId`. Within the same process lifetime, match
the warning's `pid` and `workerThreadId` to an agent-database-open warning's
`pid` and `threadId` to identify the awaited Worker. This establishes association,
not CPU attribution or a breakdown of the Worker's lifetime. A missing Worker
ID does not establish that work ran on the main thread.

Stalled embedded-run diagnostics mark `terminalProgressStale=true`
when the last bridge progress looked terminal (for example a raw response
item or response-completion event) but the Gateway still considers the
embedded run active.

Inspect the live recorder:

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --json
```

Inspect the newest persisted bundle after a fatal exit, shutdown timeout, or
restart startup failure:

```bash
openclaw gateway stability --bundle latest
```

Create a diagnostics zip from the newest persisted bundle:

```bash
openclaw gateway stability --bundle latest --export
```

Persisted bundles live under `~/.openclaw/logs/stability/` when events exist.

## CPU profile

An operator with `operator.admin` can request one in-memory profile of the Gateway's
main JavaScript isolate:

```bash
openclaw gateway call diagnostics.cpuProfile --params '{}' --timeout 30000 --json
```

This Node-only RPC requests five seconds of sampling at a 10 ms interval. It opens
no debugger port and sends no process signal. A disconnected caller or Gateway
shutdown cancels the capture and runs profiler cleanup. Overlapping requests fail
instead of queuing. No profile is written to disk or included in diagnostics exports.

The result contains `profile` in V8 CPU-profile format, `requestedDurationMs`,
`actualDurationMs`, `samplingIntervalMicros`, `redactedNodeCount`, and
`sampleLossCount: null` because V8 does not expose an explicit lost-sample count.
The complete result is limited to 1 MiB; larger profiles fail without truncating
nodes or samples. Code locations inside the OpenClaw package use `openclaw:` paths;
Node builtin locations use `node:` paths. External paths, eval labels, and other
unrecognized names are redacted. Bounded code-symbol names at recognized locations
are retained; their syntax does not prove that a computed name is public. Review
the profile before sharing it. Graph edges, native signed script IDs, and sample order remain intact. V8 can
emit samples out of timestamp order, so signed time deltas are preserved for profile
viewers to reconstruct timestamps and order samples.

Sampling can outlast the requested interval when the event loop is blocked. The
response limit does not bound V8's internal allocation during that delay. Profile
samples describe this isolate, not all process threads, and are not exact
per-function CPU accounting.

The RPC refuses a known active inspector listener, profiling flags, coverage
collection, or any active Node tracing, including non-CPU categories. Stop tracing
before requesting a profile, and do not enable it during capture: V8 can send raw
profile chunks to an existing trace writer before this RPC sanitizes the result.
The RPC cannot discover arbitrary third-party in-process inspector sessions;
do not run it alongside another debugger, profiler, tracer, or coverage owner. An unavailable
response names the reason and whether cleanup failed. If cleanup remains uncertain,
further captures are refused; the RPC never restarts the Gateway automatically.

## Sampling heap profile

An operator with `operator.admin` can sample allocations in the Gateway's main
JavaScript isolate without taking a whole-heap snapshot:

```bash
openclaw gateway call diagnostics.heapProfile --params '{}' --timeout 30000 --json
openclaw gateway call diagnostics.heapProfile --params '{"durationMs":10000,"samplingIntervalBytes":32768}' --timeout 45000 --json
```

The Node-only RPC defaults to five seconds and an average sampling interval of
32 KiB. Parameters must be positive integers. Durations above 30 seconds are
clamped to 30 seconds; intervals below 4 KiB are clamped to 4 KiB. Smaller intervals
collect more samples at greater CPU and memory cost. Choose a CLI timeout longer
than the requested capture. The critical-memory warning points to this RPC;
pressure never starts a capture automatically.

The result includes actual elapsed `durationMs`, `samplingIntervalBytes`,
`heapUsedBefore`, `heapUsedAfter`, `rssBefore`, `rssAfter` (all memory values in
bytes), `redactedNodeCount`, `unattributedSampleCount`, `unattributedSampleBytes`,
and `truncated`. When present, `profile` contains the sanitized V8 sampling tree
and samples. Each node's `selfSize` is the estimated allocation bytes at that call
site; sum its descendants for inclusive
bytes. Samples link to nodes by `nodeId`.

V8 can sample allocations made while constructing its own profile, after a call
site has been translated into the returned tree. Samples without a matching tree
node are omitted and reported in `unattributedSampleCount` and
`unattributedSampleBytes`; native tree sizes remain unchanged. `truncated` is true
when such references are omitted or a size-capped summary replaces the tree.

The complete result is capped at 1 MiB. When the tree and samples exceed that cap,
`truncated` is true and `summary` replaces `profile`. Summary entries combine
identical call stacks, retain up to eight frames in leaf-first order, and contain
`selfBytes`, inclusive `totalBytes`, and `count` (the number of sampled allocations
at those sites, not an exact object count). Entries are ordered by `totalBytes`,
then `selfBytes`; lower-ranked entries are omitted to fit the cap. Inclusive totals
overlap across callers, so do not add them together. Start with large `selfBytes`
and inspect the stack to identify the allocating code.

Sampling is cheaper than a whole-heap snapshot but is still approximate. V8's
default sampling mode excludes objects collected before capture ends; this is not
an inventory of every transient allocation or objects allocated before capture.
Native allocations, external buffers, other isolates, and other process threads
are not attributed, so sampled bytes need not explain the full RSS change.

Heap and CPU captures share one inspector owner: overlapping calls fail instead
of queuing. Both use the same redaction, runtime-conflict checks, cancellation,
and cleanup rules described above. No listener is opened and no file is written.
Event-loop stalls can extend capture duration, and the response cap does not bound
V8's internal sampling memory. Review retained code-symbol names before sharing.

## Useful options

```bash
openclaw gateway diagnostics export \
  --output openclaw-diagnostics.zip \
  --log-lines 5000 \
  --log-bytes 1000000
```

| Flag                    | Default                                                                       | Description                                        |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `--output <path>`       | `$OPENCLAW_STATE_DIR/logs/support/openclaw-diagnostics-<timestamp>-<pid>.zip` | Write to a specific zip path (or directory).       |
| `--log-lines <count>`   | `5000`                                                                        | Maximum sanitized log lines to include.            |
| `--log-bytes <bytes>`   | `1000000`                                                                     | Maximum log bytes to inspect.                      |
| `--url <url>`           | -                                                                             | Gateway WebSocket URL for status/health snapshots. |
| `--token <token>`       | -                                                                             | Gateway token for status/health snapshots.         |
| `--password <password>` | -                                                                             | Gateway password for status/health snapshots.      |
| `--timeout <ms>`        | `3000`                                                                        | Status/health snapshot timeout.                    |
| `--no-stability-bundle` | off                                                                           | Skip persisted stability bundle lookup.            |
| `--json`                | off                                                                           | Print machine-readable export metadata.            |

## Disable diagnostics

Diagnostics are enabled by default. To disable the stability recorder and
diagnostic event collection:

```json5
{
  diagnostics: {
    enabled: false,
  },
}
```

Disabling diagnostics reduces bug-report detail; it does not affect normal
Gateway logging.

Memory pressure events record RSS, heap, threshold, and growth facts
(`rss_threshold`, `heap_threshold`, `rss_growth`) without performing a
file-system scan or writing a pre-OOM snapshot.

On Node, persistent database workers collect garbage after a completed operation
when their used heap has grown by 32 MiB since the last idle collection. SQLite,
history, transcript, and reclamation workers request a 512 MiB V8 old-generation
limit; an explicit process-wide `--max-old-space-size` overrides Node's worker
resource limit. These limits do not cover native allocations or transferred buffers.
Critical memory pressure retires idle workers through their existing cleanup owners,
including when diagnostic event collection is disabled. Active operations keep
their custody and the usual 30-minute database retention window resumes after use.
No stored data, database schema, or update procedure changes.

When a task pool recreates an idle-retired Worker within five minutes, it keeps
one replacement warm for five minutes of inactivity. Other slots retain their
normal idle timeout. Node Code Mode likewise retains at most one completed
Worker for five minutes, reusing it only when its runtime entry and heap limit
match. Warm task workers still collect released payloads in place; critical
pressure, cancellation, rotation, and shutdown retain their existing cleanup
paths. No configuration setting is needed.

## Related

- [Health checks](/gateway/health)
- [Gateway CLI](/cli/gateway#gateway-diagnostics-export)
- [Gateway protocol](/gateway/protocol/rpc-methods#rpc-method-families)
- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry) - separate flow for streaming diagnostics to a collector
- [Codex harness runtime](/plugins/codex-harness-runtime) - runtime boundaries, permissions, and diagnostics for the Codex harness
- [Diagnostics flags](/diagnostics/flags) - the named flags that turn on extra logging for one subsystem without raising `logging.level` globally
