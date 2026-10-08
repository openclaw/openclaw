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

## Command-lane diagnostics

`[diagnostic] lane wait exceeded` is emitted when a queued task starts after
waiting at least its warning threshold (normally 2 seconds). `waitedMs` measures
that wait; `queueAhead` and `activeAhead` describe enqueue-time contention,
while `activeNow` and `queueBehind` describe the lane when the task starts.

Both this warning and `lane task error` include the enqueue-time `taskKind`,
`sessionKey`, `runId`, and `requesterSessionKey` when the caller supplies them.
These are structured log fields and appear on the same console line, allowing
subagent queue contention to be attributed without a separate registry lookup.
Embedded runs supply `spawn`, `turn`, or `cron` as the task kind; their session
key identifies the waiting or failed session, and their requester key is the
spawning parent when present. Queued manual cron runs supply their accepted run ID.
Unknown fields are omitted. Identity is diagnostic provenance, not authority,
and does not change admission, ordering, or warning thresholds.

## Stability recorder

The Gateway records a bounded, payload-free stability stream by default when
diagnostics are enabled. It captures operational facts, not content.

Gateway RPC diagnostics retain exact core and registered plugin method names,
including `node.invoke.result` and `workboard.cards.list`; unregistered request
names fold into `other` (dedicated worker ingress uses `unknown`). The method
label set is bounded by the registered catalog plus these fallback labels, not
by caller-supplied names. The Prometheus exporter retains its shared 2,048-sample
cap across counters, gauges, and histograms; a fully observed method uses up to
five samples. Watch `openclaw_prometheus_series_dropped_total` for incomplete
coverage. See [Prometheus metrics](/gateway/prometheus) for timing semantics.

The existing diagnostic heartbeat debug log includes `nextWakeAtMs`, the earliest
pending wake time in the Gateway scheduler as a Unix timestamp in milliseconds
(or `none` when no wake is pending). Overdue diagnostic heartbeats run once after sleep;
the scheduler does not replay missed ticks.

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

`sessions.patch` and `sessions.patchMany` calls lasting at least one second add
an info-level `slow session patch` record even when diagnostics are disabled.
The message includes total elapsed milliseconds, the method, and fixed phase
durations, for example `slow session patch 1176ms method=sessions.patch catalog=1100ms response=20ms`.
Replacement snapshots use the metadata reader for bounded exact-key selections
and the maintenance reader for larger or label-owner selections, independently of
the transcript-history reader. Snapshot time includes worker preparation and reads.
Phases distinguish lifecycle admission, snapshot reads, catalog preparation,
projection, commit, runtime acknowledgements, effects, and response work. Keeping
timings in the message makes them visible in transports that omit structured
fields. Records inherit the request's diagnostic trace when available and contain
no patch values or session keys. Repeated stage visits add to each phase's total.
Parallel and nested stages can overlap, so their totals are neither an exclusive
breakdown of request time nor CPU measurements.

Session collaboration reads emit queued `diagnostic.phase.completed` events to
interested diagnostic listeners. `session.members.list` and
`session.members.listEvidence` separate `profiles`, `evidence`, and `projection`
waits; `session.discussion.info` and `session.discussion.open` report `provider`
time, including remote provider requests. Phase names use the method as their
prefix and contain no session keys or response data. Membership evidence uses
the existing projection worker lane so full transcript reads do not block it.
The membership `projection` phase prepares creator selection metadata without
waiting for unrelated session display rows or worker-placement details. The
`evidence` phase reads membership and current management metadata in one snapshot.

With diagnostics and warning logs enabled, `sessions.create` calls lasting at
least one second emit `slow session create`. Its `elapsedMs` and
`phaseDurationsMs` separate request preparation, admission, target discovery,
worktree preparation, row snapshot and projection, transcript initialization,
writer admission, commit, publication, initial-turn dispatch, and response work.
These are elapsed times, including waits, with fixed phase names and no session
keys or request values. Worktree preparation measures only work required before
the response; provisioning already deferred to an initial turn stays with that
turn's lifecycle.

Managed worktree preparation emits one info-level `managed worktree preparation`
record on return or failure. `kind=managed` covers checkout creation;
`kind=sandbox` covers a managed guest projection through backend readiness,
including workspace/skill layout and container provisioning. `durationMs` measures
the whole operation. `phaseDurationsMs` attributes allocation admission, checkout,
setup execution, template preparation and application, snapshot capture, synchronization in each
direction, workspace layout, and container startup. Phases include nested work
and asynchronous waits, so do not add them to the total. Unentered phases are
absent. `template` is `warm`, `cold`, `unavailable`, or `reused` for an existing
projection; records contain no repository paths, session keys, or setup output.
With diagnostics enabled, the same observation feeds the
[worktree preparation histogram](/gateway/prometheus#worktree-preparation).

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

The RPC supports Node and OpenClaw's Bun runtime. It requests five seconds of sampling at a 10 ms interval and opens
no debugger port and sends no process signal. A disconnected caller or Gateway
shutdown cancels the capture and runs profiler cleanup. Overlapping requests fail
instead of queuing. No profile is written to disk or included in diagnostics exports.

The result contains `profile` in V8 CPU-profile format, `requestedDurationMs`,
`actualDurationMs`, `startBlockedMs`, `samplingIntervalMicros`, `redactedNodeCount`, and
`sampleLossCount: null` because the native profilers do not expose an explicit lost-sample count.
Node samples V8; Bun samples JavaScriptCore and returns the same profile format.
The complete result is limited to 1 MiB; larger profiles fail without truncating
nodes or samples. Code locations inside the OpenClaw package use `openclaw:` paths;
Node builtin locations use `node:` paths. External paths, eval labels, and other
unrecognized names are redacted. Bounded code-symbol names at recognized locations
are retained; their syntax does not prove that a computed name is public. Review
the profile before sharing it. Graph edges, native signed script IDs, and sample order remain intact. V8 can
emit samples out of timestamp order, so signed time deltas are preserved for profile
viewers to reconstruct timestamps and order samples.

Sampling can outlast the requested interval when the event loop is blocked. The
response limit does not bound the runtime's internal allocation during that delay. Profile
samples describe this isolate, not all process threads, and are not exact
per-function CPU accounting.

On Node, starting a CPU profile synchronously scans V8's heap to build its code map. On a
large Gateway this can block the main event loop for seconds on every capture
(about 3.5 seconds has been observed with a 3 GB heap),
before regular sampling begins. Keeping the inspector domain enabled or sending
the request from a Worker does not avoid that main-isolate work.
`startBlockedMs` measures the synchronous start call with a monotonic clock,
excluding promise waits, setup, sampling time, and stop/cleanup. Use it to
attribute capture-induced stalls when analyzing an individual capture; it cannot
be subtracted from aggregate event-loop maxima or percentiles. The measurement
reports the cost; it does not prevent or interrupt the native stall.

The RPC refuses a known active inspector listener, profiling flags, coverage
collection, or any active Node tracing, including non-CPU categories. Stop tracing
before requesting a profile, and do not enable it during capture: V8 can send raw
profile chunks to an existing trace writer before this RPC sanitizes the result.
On Bun the RPC also refuses nonempty `BUN_INSPECT` or `BUN_INSPECT_CONNECT_TO` settings,
which can activate debugging without appearing in `inspector.url()`.
The RPC cannot discover arbitrary third-party in-process inspector sessions;
do not run it alongside another debugger, profiler, tracer, or coverage owner. An unavailable
response names the reason and whether cleanup failed. If cleanup remains uncertain,
further captures are refused; the RPC never restarts the Gateway automatically.

## Full heap snapshot

An operator with `operator.admin` can explicitly capture the Gateway's main JavaScript
isolate, including objects allocated before the request:

```bash
openclaw gateway call diagnostics.heapSnapshot --params '{"reason":"retention baseline"}' --timeout 180000 --json
```

The RPC supports Node and OpenClaw's Bun runtime and writes V8-compatible snapshot JSON.
It accepts only an optional `reason` (at most 256 characters),
recorded in the warning before capture. No configuration switch is needed. It
writes `<state>/diagnostics/heap-<timestamp>.heapsnapshot` with owner-only file
permissions and returns `path`, `sizeBytes`, `heapUsedBefore`, `heapUsedAfter`
(bytes), and `elapsedMs` (native capture wall time). Snapshot contents never travel
over the WebSocket or enter the diagnostics export. Worker isolates are excluded.

**Take snapshots in a quiet window.** A 3 GB heap snapshot can block the main
thread for tens of seconds. V8 may need roughly twice the heap's memory while
capturing; sufficient memory and disk headroom remain the operator's responsibility.
The RPC refuses heaps above 6 GiB, overlapping CPU/heap captures, and another snapshot within
60 seconds of a native attempt finishing. It also shares the profiling RPCs' refusal
of known debuggers, profiling flags, coverage, and active Node tracing. These admission guards do not impose a
hard duration, output-size, or memory limit: synchronous `writeHeapSnapshot()`
cannot be interrupted by a timeout, disconnection, or shutdown once started.
A client timeout does not mean capture stopped; inspect the host directory before
retrying. After capture, the diagnostic owner disables the heap profiler and
disconnects its inspector session, releasing the runtime's retained snapshot metadata.
On Node this also releases V8's object-ID map and object-move tracking, so later garbage
collections do not keep paying snapshot tracking costs.
Failed captures remove partial files when possible; `cleanupFailed`
reports whether profiler cleanup or file removal failed.

Snapshots are **unredacted** and can contain credentials, prompts, and private
messages. Keep them on the host, review any transfer separately, and delete them
manually after analysis. Successful snapshots are retained until removed; there
is no automatic snapshot collection or retention job.

RPC snapshots reset object IDs after each capture. Inspect their retaining paths
individually; do not correlate their object IDs or use them as inputs to the
identity-based diff below. For an identity-based comparison, capture two points
through the same continuously attached debugger on an isolated analysis process,
then compare them from a source checkout:

```bash
node scripts/heap-snapshot-diff.mjs before.heapsnapshot after.heapsnapshot
```

The tool reports retained bytes by constructor/class and the largest changes by
dominator (the object through which all strong root paths pass). It streams input
and analyzes snapshots sequentially, but still needs memory proportional to the
object graph; run large diffs on a separate analysis host with enough memory.
Weak and shortcut edges are excluded. Class totals count nested instances of the
same class once; totals across different classes can overlap. Object IDs match
only while the same isolate's object-ID map remains active. Use Chrome DevTools for interactive retaining
paths and V8-specific weak/ephemeron semantics; the script is a strong-edge graph
summary. `--json` produces machine-readable output. Treat diff output as sensitive
too: it contains unredacted heap names.

Add `--top 40 --max-depth 60` to include named strong retaining paths and
dominator chains for the largest growers. `--node <id>` selects a particular
object in the later snapshot. A shortest root path shows reachability;
the separate dominator chain identifies exclusive retention in that graph.

From a built source checkout, an isolated synthetic workload can collect a
pair of standalone RPC snapshots without connecting to an existing Gateway:

```bash
node scripts/gateway-heap-rig.mjs --root .rig/node26 --minutes 90
```

Run this on a dedicated host with enough memory for snapshots. It starts the
dist Gateway and local mock model servers on loopback ports 19548–19550,
seeds 2,000 sessions across two agents, and drives ten reconnecting Control UI
WebSocket clients plus mock model, Code Mode, and subagent turns. A synthetic
catalog plugin exercises Gateway projection and publication ownership; it does
not emulate a native provider's caches or remote-node transport.
The root must be new. All state, logs, minute samples, and snapshots stay there.
The rig stops its children on completion or interruption and retains evidence.
Successful RPC counts and any retried refusals are recorded separately. If
`projects.list` refuses a read because access facts changed, the rig retries it
once; a second refusal or another error stops the run.
Use the same script and settings with another Node binary for a runtime control;
choose another root and three-port block for each run. Raw minute samples include
allocation churn; compare the snapshot `heapUsedAfter` anchors for post-GC growth.

## Sampling heap profile

An operator with `operator.admin` can sample allocations in the Gateway's main
JavaScript isolate without taking a whole-heap snapshot:

```bash
openclaw gateway call diagnostics.heapProfile --params '{}' --timeout 30000 --json
openclaw gateway call diagnostics.heapProfile --params '{"durationMs":10000,"samplingIntervalBytes":32768}' --timeout 45000 --json
openclaw gateway call diagnostics.heapProfile --params '{"includeObjectsCollectedByMajorGC":true,"includeObjectsCollectedByMinorGC":true}' --timeout 30000 --json
```

The RPC supports Node and OpenClaw's Bun runtime. It defaults to five seconds and an average sampling interval of
32 KiB. `durationMs` and `samplingIntervalBytes` must be positive integers. With
both collection flags false, durations are capped at 15 minutes (900,000 ms).
Enabling either collection flag keeps the duration cap at 30 seconds;
intervals below 4 KiB are clamped to 4 KiB. Smaller intervals
collect more samples at greater CPU and memory cost. Choose a CLI timeout longer
than the requested capture. The critical-memory warning points to this RPC;
pressure never starts a capture automatically.

The optional booleans `includeObjectsCollectedByMajorGC` and
`includeObjectsCollectedByMinorGC` both default to `false`. Enable both to retain
samples of objects collected during the window and attribute transient allocation
churn. Retaining collected samples can increase profiler memory use.

For retention attribution, keep both collection flags false (the default) and
use a longer window with a coarser sampling interval:

```bash
openclaw gateway call diagnostics.heapProfile --json --timeout 930000 --params '{"durationMs":900000,"samplingIntervalBytes":262144}'
```

Read each node's `selfSize` in `profile.head` as estimated bytes **allocated
during the window and still alive at stop**. These are allocation sites, not
retaining paths or objects allocated before capture. The 930,000 ms CLI timeout
allows 30 seconds beyond the requested window for setup and cleanup; event-loop
stalls can require more time. Disconnection, authority revocation, or Gateway
shutdown cancels sampling and discards the partial profile after cleanup.

The result includes actual elapsed `durationMs`, `samplingIntervalBytes`,
`includeObjectsCollectedByMajorGC`, `includeObjectsCollectedByMinorGC`,
`heapUsedBefore`, `heapUsedAfter`, `rssBefore`, `rssAfter` (all memory values in
bytes), `redactedNodeCount`, `unattributedSampleCount`, `unattributedSampleBytes`,
and `truncated`. When present, `profile` contains the sanitized V8-format sampling tree
and samples. Each node's `selfSize` is the estimated allocation bytes at that call
site; sum its descendants for inclusive
bytes. Samples link to nodes by `nodeId`.

`heapSpacesBefore` and `heapSpacesAfter` contain the main isolate's `node:v8` heap-space
statistics at the same boundaries as the memory readings: `space_name`,
`space_used_size`, `space_size`, `space_available_size`, and `physical_space_size`
(sizes in bytes). Compare entries by name to locate growth in old, large-object,
code, or other spaces on Node. Bun reports its JavaScriptCore heap in `old_space`;
the other V8-named spaces are zero rather than separate JavaScriptCore regions.
On Node, the [Prometheus exporter](/gateway/prometheus)
also exposes `openclaw_heap_space_bytes{space="<space_name>",stat="used|size|available|physical"}`
from the existing 30-second diagnostic memory heartbeat, with the same idle
sample suppression, never per scrape. Names come from V8's finite space set,
including spaces added by future V8 versions; each space contributes four gauges
under the exporter's existing series cap.

Heap and CPU profiles label dependency frames as `[dep:<pkg>]` with URL
`node_modules/<pkg>`, including scoped packages and pnpm layouts; symbols,
versions, filenames, and absolute paths stay hidden. URLs with query or fragment
markers remain redacted. Frames with script ID `0`,
an empty URL, and a negative line number use `[native]`, except for known V8
engine labels such as `(root)`. This bucket identifies missing JavaScript source
attribution, not a specific native allocator or external Buffer bytes. Other
unrecognized frames remain `[redacted]`; `redactedNodeCount` excludes dependency
and native labels (CPU nodes with hidden deoptimization reasons still count).

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

Sampling is cheaper than a whole-heap snapshot but is still approximate. The
default sampling mode excludes objects collected before capture ends; enable both
collection flags to include those samples. Neither mode is an exact inventory of
every allocation or includes objects allocated before capture.
Native allocations, external buffers, other isolates, and other process threads
are not attributed, so sampled bytes need not explain the full RSS change.

Heap and CPU captures share one inspector owner: overlapping calls fail instead
of queuing. Both use the same redaction, runtime-conflict checks, cancellation,
and cleanup rules described above. No listener is opened and no file is written.
Event-loop stalls can extend capture duration, and the response cap does not bound
the runtime's internal sampling memory. Review retained code-symbol names before sharing.

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

Memory pressure warnings start at 80% of a measured limit; critical pressure starts
at 90%. The main thread's V8 `heap_size_limit` is the primary signal
(`heap_threshold`). Each fresh worker sample is compared with that worker's own V8
limit (`worker_heap_threshold`), including process-wide heap flag overrides. RSS
includes every worker and native allocation, so `rss_threshold` uses the smaller of
physical RAM and the process/cgroup memory constraint, independently of V8 heap
limits. Unknown limits are omitted; Bun's compatibility heap metadata is not treated
as a V8 limit. RSS growth alone does not indicate pressure.

Warning and critical journal lines and diagnostic events retain the measured
`usedBytes`, `limitBytes`, and `thresholdBytes`; worker pressure also identifies
`workerThreadId`. The detector performs no file-system scan, forced main-thread GC,
or pre-OOM snapshot. `openclaw_memory_bytes` remains unchanged.

Persistent database workers collect garbage after a completed operation when their
used heap has grown by 32 MiB since the last idle collection. This uses the runtime's
local inspector collection support; runtimes that report the method as unavailable
skip idle collection. On Node, SQLite,
history, transcript, and reclamation workers request a 512 MiB V8 old-generation
limit; an explicit process-wide `--max-old-space-size` overrides Node's worker
resource limit. These limits do not cover native allocations or transferred buffers.
Memory diagnostics report each sampled direct worker by script and thread ID,
including its heap, measured heap limit, and external memory. Task workers also publish ArrayBuffer
bytes from inside their isolate; ArrayBuffers are already included in external
memory, so do not add those values together. Other direct workers use native heap
statistics and leave ArrayBuffer bytes unavailable. Nested workers are outside
the parent registry's coverage.

`workerHeapSampledCount` and `workerArrayBuffersSampledCount` show coverage against
`workerCount`. `workerMemoryCoverage` is `complete`, `partial`, or `unavailable`
for direct workers. Before the first sample or after a sample expires, missing
bytes are omitted instead of reported as zero; `workerMemoryMissing` identifies
pending, stale, or unavailable workers. Samples expire after 60 seconds. Sampling
never waits for a busy worker and keeps at most one request outstanding per
transport. If a worker cannot handle port messages, native V8 interrupts still
refresh its heap and external counters; ArrayBuffer coverage remains unavailable
until the worker responds. Memory pressure warnings include these counters and the external-memory
limit caveat; Node does not provide a worker limit for external/native allocations.

Critical memory pressure retires idle workers through their existing cleanup owners,
including when diagnostic event collection is disabled. Warnings do not retire
workers. Retirement requests are asynchronous, skip active work, and keep native
close/checkpoint operations off the main thread. Active operations keep their
custody and the usual 30-minute database retention window resumes after use.
No stored data, database schema, or update procedure changes.

When a task pool recreates an idle-retired Worker within five minutes, it keeps
one replacement warm for five minutes of inactivity. Other slots retain their
normal idle timeout. Node Code Mode likewise retains at most one completed
Worker for five minutes, reusing it only when its runtime entry and heap limit
match. Warm task workers still collect released payloads in place; critical
pressure, cancellation, rotation, and shutdown retain their existing cleanup
paths. No configuration setting is needed.

## RPC response size and heap changes

The [Prometheus exporter](/gateway/prometheus) records
`openclaw_gateway_rpc_response_bytes` for each encoded JSON response frame accepted
by the WebSocket sender (UTF-8 bytes, excluding transport framing/compression),
with power-of-two buckets from 1 KiB to 64 MiB. Slow-response journal lines include
`bytes=` for the same frame; it always means encoded response bytes, never heap
allocation or an exclusive-window sample.

For `sessions.list`, response journal lines and `slow session list` records also
include `source`, `rowMode` (`compact` or `full`), `limit`, `offset`, and
`filterKind`. The caller source is a bounded Control UI tag or `unspecified`;
filter kinds contain parameter names, never search text, identities, or paths.
The optimized WebSocket journal also records fast `sessions.list` responses of
at least 200 KiB. Metric labels remain unchanged.

`openclaw_gateway_rpc_handler_heap_delta_bytes` samples main-thread
`process.memoryUsage().heapUsed` immediately around handler execution. A sample
is emitted only if that handler was the sole active RPC handler for its entire
lifetime, including awaits. Any overlap discards the whole sample, even if the
other handler finishes first. Normal, dedicated worker-connection, and in-process
RPC handlers share this boundary. Admission, queueing, rejected requests, and
worker-thread heaps are excluded.

`openclaw_gateway_rpc_handler_heap_delta_exclusive_total{method}` counts sampled
handlers. Compare its increase with `openclaw_gateway_rpc_handler_seconds_count`
for the same method to see coverage. Overlapping handlers contribute no heap
sample, not a zero; sustained concurrency can leave a method with no samples.
The sampled subset favors short handlers and quiet periods.

These are signed heap changes, not per-handler allocation totals. Background
work, response encoding, and GC still affect exclusive windows. GC notifications
are asynchronous, so samples are not GC-filtered and can be negative. Use bucket
counts or quantiles; the signed `_sum` can decrease, so `rate()` on that sum is not
valid. Do not sum across methods to estimate allocation throughput. Both
histograms use registered method labels and the existing exporter cap, without
new configuration; disabled or uninterested diagnostics skip heap sampling.

## Related

- [Health checks](/gateway/health)
- [Gateway CLI](/cli/gateway#gateway-diagnostics-export)
- [Gateway protocol](/gateway/protocol/rpc-methods#rpc-method-families)
- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry) - separate flow for streaming diagnostics to a collector
- [Codex harness runtime](/plugins/codex-harness-runtime) - runtime boundaries, permissions, and diagnostics for the Codex harness
- [Diagnostics flags](/diagnostics/flags) - the named flags that turn on extra logging for one subsystem without raising `logging.level` globally
