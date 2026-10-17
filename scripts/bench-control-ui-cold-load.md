# Team-scale Control UI cold-load benchmark

Run from a prepared checkout with its package dependencies and Playwright Chromium:

```sh
node --import tsx scripts/bench-control-ui-cold-load.ts
```

This opt-in benchmark builds the production Control UI into a fresh artifact directory,
warms a signed-in synthetic dashboard visit, and measures three reloads. It never
connects to a real Gateway or account. The reusable inventory is
`ui/src/test-helpers/control-ui-team-scale-fixture.ts`; its browser contract is
`ui/src/e2e/team-scale-cold-load.e2e.test.ts`.

The browser contract belongs to the existing release-only UI tier. Automatic CI
runs it only when that test file changes; full manual/release validation retains
it. The fixture remains in the normal UI TypeScript graph. To run the contract
explicitly:

```sh
pnpm test ui/src/e2e/team-scale-cold-load.e2e.test.ts --maxWorkers=1
```

The selected agent has 300 root sessions plus 54 children, 24 cron sessions and 12 system sessions, with a 200-row shared first page, 30 pinned dashboards, 34 owners, 120 people, six agent identities (one selected chip), seven UI plugins,
240 transcript messages, 120 cron jobs across enabled, disabled, running and error states, and 12 inline widgets. Six catalog-host events and twelve
full presence snapshots arrive individually. Catalog notifications exercise the data
owner; the grouped agent roster does not display catalog rows. Widgets use the production sandbox
host on a separate loopback listener. Plugins are small synthetic modules exercising
registration/loading, not replicas of any private plugin implementation.

`--latency-ms` sets the inbound message delay (default 35 ms). `--frame-gap-ms`
sets the minimum separation between Gateway message deliveries (default 4 ms).
Concurrent requests remain concurrent; replies share one serialized wire.
`--sidebar-view` selects `sessions` (default, with Involving me selected) or `online`.
Run both because current UI presents these inventories in separate sidebar views.
The fixture uses the single-agent chip sidebar, matching the live boot query shape.
The explicit churn scenarios retain their all-agent roster mode.
The Online run also requires the saved sidebar view to survive the reload. If it
returns to Sessions, the run fails instead of reporting Sessions measurements as
Online measurements.
`--runs` accepts 1–20 reloads. `--output` selects the artifact parent.
`--bundle-dir` serves an already built production bundle instead of rebuilding it;
keep its build identity equal to the checkout head. This preserves a baseline
bundle while production sources are edited.

The initial warm visit flushes the selected transcript through its cache owner and
verifies both its persisted snapshot and the sidebar's saved view. Current v8
persistence trims the transcript to its last 80 messages (whole sequence groups may
extend that bound), strips replay metadata and retains authoritative pagination.
Before each measured reload, the bench unloads the app into an empty same-origin
document, replays the original snapshot records and browser preferences, and restores
the deep-link URL. It also clears the separate composer draft store: the synthetic
warm visit starts empty, and streaming input must not become the next reload’s draft.
This keeps pagehide writes and live events from changing the next
run's transcript or sidebar, while preserving the browser's HTTP cache. Only the
subsequent app reload is measured.
`snapshotSave` records database/projection versions, message count, sidebar shape
and UTF-8 sizes; its save costs describe the initial warm visit. A missing cache or
wrong saved view fails setup.

`--route board|chat` selects a dashboard (default) or chat deep link for the same
session. Chat measurements require inline content, without requiring a board frame.

`--warm-reload --probe-dir /path/to/probes` adds cache/paint diagnostics. The probe directory supplies `loaf-mutation.init.js` and
`ws-rpc-census.init.js`. The output records cache reads, cached transcript visibility,
hello, live catch-up, enabled input, layout shifts, mutation batches, and retained
row elements. Visibility and enabled-input milestones are DOM observations;
FCP is the browser's paint metric. Diagnostic runs also save filmstrip frames.
Use `--untraced` for timing comparisons without boot tracing or CPU sampling,
then collect separate traced runs for the storyboard and attribution.

`--large-snapshot` expands the transcript to 1,100 synthetic messages (about 3 MB),
including tool results and replay metadata. Combine it with `--warm-reload` to
exercise a large live history with the current bounded IndexedDB restore. `snapshotSave` reports the persisted
row count and UTF-8 bytes, synchronous serialization time, and total flush time
for the initial save through the live cache owner.

The dashboard fixture includes reaction pickers, widget actions, context usage,
and viewers. Use `--warm-reload` to measure its cached restore. Transaction labels
in diagnostic traces distinguish transcript, sidebar, and composer cache
completions; a completion callback can include later render microtasks and is
not a measurement of native IndexedDB cost alone.

`--live-events` adds 125 synthetic live frames over 20 seconds after each reload
settles. The stream mixes full presence snapshots, session patches for displayed,
held-but-hidden, and outside-window rows, open-session messages and assistant
streaming, changing catalog hosts, and unrelated cron/run-state activity. The live
phase runs after reload tracing and CPU sampling stop; `--cpu-profile` starts a separate live CPU capture. The selected session starts with an
active canonical run; live messages and deltas advance its history receipt before
publishing the event, so later history reads retain the same messages and stream. Capture ends after all frames
arrive and the planned 20-second stream plus 750 ms have elapsed; busy sessions
need not become idle. `plannedWindowMs` and the observed `elapsedMs` distinguish
the planned window from delayed delivery on a loaded host. Its `run-N.live.json` records
observed Solid owner calls and bounded lifecycle scheduling stacks per event label, plus DOM
snapshots of the affected rows, chat viewers, and streaming text; `run-N.live.png`
shows the synthetic final state. Row attachment and viewport visibility distinguish
an absent row from a rendered row below the fold.

For the Solid sidebar, `solidSidebar.lifecycle` separately counts owner
`invalidate` calls and `prepareRender`/`commitRender` projection lifecycle
passes. Bounded owner and session-data origin stacks identify their callers. These
are not full Solid render counts: fine-grained bindings update independently. The
init probe captures the existing host-to-owner WeakMap registration, restores that
tap immediately, and restores the owner wrappers at the end of the live phase.
A missing sidebar or pane owner fails the capture instead of reporting zero work.

`solidChat` counts the pane runtime's actual `render` calls and existing lifecycle
hook notifications. Each render retains any explicit lifecycle invalidation IDs
and scheduling stacks received since the preceding render. Unattributed renders
and remaining pending producers are explicit; domain mutations and fine-grained
bindings can update without a whole-pane render or lifecycle invalidation.
Owner and element notifications remain separate, so their combined count is not
a DOM commit count. The probe preserves and restores the hook's complete
descriptor, including the test adapter's accessor, and the pane render method.
Page snapshot computations and fine-grained Solid bindings are explicitly listed
as unmeasured. Use source-mapped CPU profiles for those paths; a missing counter
is not evidence of zero work. The retired Lit counters are no longer emitted.

Live updates are attributed to the most recently delivered event label. Paced
refreshes and clock-driven presence updates may finish during a later event's
interval; inspect their scheduling stacks before treating a per-label count as
causal. Compare total steady-state render counts and renders per second as well.
Wall-clock durations and frame coalescing vary on a loaded host. The benchmark's
static RPC responses are not authority for live title/run-state correctness; use
focused browser contracts with updated authoritative mock responses for that proof.

Each invocation keeps its exact Git head and dirty-tree inventory, raw Chrome trace,
CPU profile, settled screenshot, and JSON summary in a fresh timestamped directory.
It measures renderer-main-thread task interval union, long tasks, layouts with
JavaScript stacks, observed Solid lifecycle calls, source-mapped CPU self-time hotspots,
Solid flush self/inclusive sampled time, and RPC request/response bytes. The top
20 CPU entries retain browser/GC overhead alongside source-attributed call sites.
A reload settles after all scheduled fixture events and outstanding RPCs complete,
then 750 ms with no wire or captured Solid lifecycle activity. That quiet interval is measurement padding,
not part of a correctness test.

Filmstrip frames come from Chrome tracing. Significant changes compare consecutive
frames at 344×236: at least 0.4% of pixels differ by at least 32 in an RGB channel.
Significant frames separated by more than 100 ms start a new transition group.
These automated groups are not equivalent to the campaign's manually selected
visual states. Profiling/instrumentation adds overhead; compare runs on the same
machine, Chromium version, fixture, latency, and profiling settings.

This measures the production renderer against the existing mock Gateway. It cannot
measure server CPU, HTTP authentication/proxy redirects, real plugin bundle cost,
or a service-worker cache (service workers are blocked). The original real-Gateway
latency rig remains useful for those boundaries. Synthetic fixture fidelity and
measured results must be reported separately from private deployment evidence.

## Source-mapped CPU attribution

Use `--cpu-profile --live-events --untraced` to collect separate reload and live
profiles without the additional timeline trace. CPU mode leaves the
owner-method and animation-frame wrappers disabled (`ownerProbes: false`,
`solidChat`/`solidSidebar` absent as `null`); source stacks supply the attribution.
This also lets live replay run after renderer owners have been replaced by native
Solid components. `--cpu-profile` also captures
`--streaming-reply` when selected. Each phase prints self time, inclusive function
time (application sources first), and inclusive source-file time. Recursion and
multiple frames from one file count once per sample. All rows are saved in
`run-N.cpu-profile.json`; `cpu-profile.json` holds per-row medians, treating missing
functions as zero. Raw phase profiles retain unmapped browser/native frames.
The mapper reads adjacent `.js.map` files, including hidden release maps, and
reports missing mappings; keep maps alongside any `--bundle-dir` assets.

`--cpu-profile-compare /path/to/baseline/cpu-profile.json` enables profiling and
prints candidate-minus-baseline self/inclusive function deltas, also saved in
`cpu-profile-compare.json`. A per-run report is accepted too. Function identity is
source path, name, line and column; moving a function appears as a removal/addition.
Mapped filesystem paths are repository-relative, independent of the build output directory.
Use the same fixture, phases, sampling and machine for both captures.
Profiling inflates timing: use these tables to prove the hot path runs, then
measure improvements in separate unprofiled, interleaved runs.

## Initial baseline

Production UI at `488c0a3850fc`, Blacksmith Testbox, three Sessions reloads with
35 ms reply latency and 4 ms frame spacing:

| Metric                                              |   Median |             Range |
| --------------------------------------------------- | -------: | ----------------: |
| Navigation to settle, including 750 ms quiet window | 4,444 ms |    4,398–5,128 ms |
| Main-thread busy time                               | 3,263 ms |    3,109–3,647 ms |
| Long tasks                                          |       15 |             11–16 |
| Forced layouts                                      |       38 |             37–40 |
| Forced-layout time                                  |   434 ms |        399–509 ms |
| Lit updates                                         |    1,100 |       1,091–1,104 |
| Solid flush inclusive sampled time                  |   690 ms |        598–788 ms |
| Boot RPCs                                           |       85 |             85–86 |
| RPC request + response bytes                        |  942,400 | 942,400–1,024,426 |
| Filmstrip transition groups                         |        5 |                 5 |

This reproduces the high update volume that the earlier small synthetic fixture
missed. The largest source-attributed native getter is `scrollHeight` from
`ui/src/components/scroll-state-observer.ts:19` (107–199 ms sampled self time).
The Online attempt returned to Sessions after reload and is excluded from these
numbers; the fixture E2E opens Online explicitly to verify all 120 people.

## Live-shape fidelity

The synthetic list owner applies each query's filters and canonical Gateway ordering before pagination,
including pin placement for the default sort and the requested activity clock. All
30 pins appear in the shared first page; Involving me retains its independent membership.
It then projects canonical compact/sidebar/dashboard fields. Owner-first prefixes follow
the Gateway contract independently of the shared page offset. Derived titles and
last-message previews use the protocol's enrichment bound. Compact cron requests
page the inventory as 50/50/20; all seven synthetic plugins activate normally.
The bench uses this owner for every query, including non-churn runs.

Compare board and chat reload captures with sanitized live function/RPC inventories:

```sh
node scripts/control-ui-bench-fidelity.ts \
  --board <board-artifacts> --board-live <mapped-board-profile.txt> --board-rpcs <board-method-counts.json> \
  --chat <chat-artifacts> --chat-live <mapped-chat-profile.txt> --chat-rpcs <chat-method-counts.json> \
  --analyzer <campaign-rig>/bench/cpuprof/cpuprof2.py --output <report-directory>
```

This reuses the campaign analyzer's source mapping and inclusive CPU accounting;
it does not add a profiler. Keep raw profiles and adjacent build maps together, or
pass `--board-assets`/`--chat-assets`. Live RPC JSON has the explicit shape
`{"complete": true, "counts": {"connect": 1, "sessions.list": 5}}` with sanitized
method counts. Set `complete` to `false` for partial evidence: it remains reportable
but cannot pass the RPC gate. Every observed bench method needs an explicit live
count, including zero; omitted counts stay unknown even when `complete` is `true`. Private capture text and profile preambles are never
included in the report. The report preserves each run's shares/counts, prints
median and IQR, and exits nonzero unless at least 15 of the top 20 unique live app
locations fall within 0.5–2× live share and a complete live RPC census supplies an
explicit count for every observed bench method, within ±1 in every run.
It requires a successful capture and every requested reload's metrics/profile pair;
an aborted capture cannot pass using only its completed iterations. Each benchmark
frame can match at most one live function, with a unique name taking priority over
a stale source-line match.
Functions absent from the analyzer's top-70 output are reported as not observed
and fail the gate; absence is not a measured zero CPU share. Same-line aliases
use their maximum inclusive time. Inspect matching locations across revisions: semantic names bridge line
shifts only when unambiguous. A failed fidelity gate is a measurement limitation,
not evidence that an application optimization is ineffective.
