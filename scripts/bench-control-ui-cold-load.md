# Team-scale Control UI cold-load benchmark

## Media load, remount, and disposal

`bench-control-ui-media.ts` compares **already-built** base and head bundles with
96 synthetic transcript messages (16 repeated 1600×900 PNGs, eight repeated link
hosts) and the existing 120-person avatar fixture. It never builds or contacts a
real Gateway. Each pair gets fresh browser contexts, alternates AB/BA order, and
runs both localhost and 100 ms RTT / 10 Mbps profiles by default:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-media.ts \
  --bundle-dir /absolute/base/control-ui \
  --compare-bundle-dir /absolute/head/control-ui \
  --pairs 10 --output /absolute/proof/media
```

The initial viewport is settled while media is held. Releasing those requests
measures media-induced CLS separately from scrolling. Each measured phase allows
intersection admission frames, then waits for all admitted media HTTP requests
and visible loading images/favicons across two settled frame checks; unadmitted
off-screen placeholders do not block. The runner then scrolls the
transcript and online roster, remounts the first/last rows, and removes the native
`openclaw-app` host to exercise production disconnection while preserving the
document for lifetime measurement. Settings parks chat and cannot prove disposal.
A document nonce assertion rejects any reload as invalid disposal evidence.
Per-sample JSON records request counts by full URL (including revision, ticket,
and size queries), method, kind and opaque auth-context identity; credentials are
never recorded. Cumulative before/stable/scroll/disposal snapshots and separate
boot/steady duplicate counts distinguish request ownership from bootstrap work.
Duration metrics use Chrome’s `threadTicks` clock to measure thread CPU time,
excluding time descheduled by other work on the host. Wall-clock load/scroll
timings remain separate.

It also records CLS source rectangles and media attribution, object URL
creation/revocation and remaining DOM consumers, CDP script/task/layout/style
duration, and JS heap before scrolling and after forced GC immediately before
and after host disconnection, including unreferenced favicon blob URLs. The
first pair includes pending and loaded screenshots for each bundle/profile.
`summary.json` retains every sample, load
average, bundle identity, and median/p95 load/scroll timings.

Acceptance is zero CLS in the fixed media viewport, at most one fetch per unique
media resource and kind, and no live object URLs owned only by disposed markdown
consumers. Review retained URLs against their actual owner: a documented shared
page-lifetime cache is distinct from a disposed consumer leak. Timing needs ten
pairs with median regression ≤5% and p95 not worse. On a loaded host, repeat with
the same base directory supplied as both bundles for an A/A control, then use
20 interleaved pairs and CDP CPU plus structural counters if wall timing is noisy.

Use a separate `--trace --pairs 1` run for decode/paint attribution; tracing adds
overhead and must not be mixed with the untraced timing samples. The trace and
named-event duration sums are retained per sample. CDP JS heap excludes native
decoded-image/GPU memory. The mock RPC transport has no RTT; static HTTP uses CDP
throttling and routed media uses equivalent explicit delay because Playwright
fulfillment bypasses it. Routing disables the HTTP cache, so duplicate counts
measure application request reuse rather than disk-cache behavior. These are
renderer/media results, not real-Gateway throughput or process-memory results.

Run from a prepared checkout with its package dependencies and Playwright Chromium:

```sh
node --import tsx scripts/bench-control-ui-cold-load.ts
```

For cold readiness comparisons, use `--gateway-http` with already-built bundles.
It serves documents and assets through the production Gateway HTTP handler,
including route preload hints and negotiated compression sidecars:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-cold-load.ts \
  --gateway-http --bundle-dir /absolute/base/control-ui \
  --compare-bundle-dir /absolute/head/control-ui --runs 20 \
  --first-load --cold-http-cache --untraced --thread-cpu-time --critical-path \
  --face chat --critical-path-route sessions --critical-path-route settings \
  --critical-path-route cron --output /absolute/proof/readiness
```

Twenty runs alternate ten base/head pairs. Supply a second copy of the base
bundle for an A/A control. `--boot-route new` measures the New Session composer.
Browser storage and HTTP caches are cleared between samples; Gateway asset
caches stay warm for each immutable bundle. Each bundle's index is read before
sampling to initialize the shared file reader outside the first timed reload.
The WebSocket/bootstrap fixtures
remain synthetic, so this measures the production HTTP and renderer paths,
not Gateway RPC or provider latency. The default Vite preview server does not
activate Gateway route preload hints or serve the shipped compression sidecars;
retain that mode for renderer diagnostics rather than network-readiness claims.

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

`--latency-profile live-fast` replays a fast-handshake delivery envelope:
challenge no earlier than 439 ms from navigation, connect reply no earlier than
41 ms after send, ordinary messages 20 ms, and no inter-frame spacing. Critical
boot methods have individual request-to-delivery floors:

| Method                        | Floor (ms) |
| ----------------------------- | ---------: |
| `chat.startup`                |        220 |
| `sessions.resolve`            |        216 |
| `sessions.describe`           |        149 |
| `sessions.list`               |        195 |
| `sessions.subscribe`          |        117 |
| `sessions.messages.subscribe` |        183 |
| `board.get`                   |        189 |
| `users.list`                  |        144 |
| `agents.list`                 |        149 |
| `agent.identity.get`          |        150 |
| `plugins.controlUi.list`      |        125 |
| `cron.list`                   |        165 |
| `workboard.boards.list`       |        141 |

These rounded medians come from the first reply per method in six signed-in
reload observations (three chat, three dashboard). Challenge delivery was
344–566 ms from navigation; connect RTT was 25–162 ms. The observations include
browser queueing and server work: replaying them as floors is a conservative
scheduling scenario, not an isolated network model. Ordinary-message delay stays
at 20 ms to avoid applying boot congestion to every later event. Repeated calls
still use the method floor; they do not reproduce the faster later live replies.
Socket-open timestamps were absent, so the challenge uses a navigation floor,
not an inferred socket-open delay. Document/proxy latency is not simulated.

`--latency-profile legacy-handshake` reproduces the earlier campaign scenario:
340 ms challenge floor, 220 ms connect, 195 ms resolve/describe, 20 ms ordinary
messages and zero frame spacing. The default profile retains the original
35 ms / 4 ms / no challenge floor settings. Explicit `--latency-ms`,
`--frame-gap-ms`, `--connect-not-before-ms`, `--method-latency-ms` and
`--sidebar-query-latency-ms` overrides take precedence over any profile.
`summary.json` records the selected profile and all effective floors. Warm-reload
milestones include `socketOpen`, `challenge`, `connectSent`, `hello` (reply
dispatch) and dashboard-stage `helloHandledMs`; keep the handled milestone as a
separate gate when moving work near the handshake. Profile selection alone does
not qualify a product scheduling change against live behavior.

`--latency-ms` sets the inbound message delay (default 35 ms). `--frame-gap-ms`
sets the minimum separation between Gateway message deliveries (default 4 ms).
Concurrent requests remain concurrent; replies share one serialized wire.
`--sidebar-query-latency-ms ownerFirst=400` (also `involvingMe`, `ownerCounts`, and
`children`) overrides method latency for that sidebar query shape. Use
`--omit-hello-self-presence --method-latency-ms users.self=900` to exercise identity
resolution after hello. `--sidebar-avatars` supplies synthetic avatar resources;
`--sidebar-expanded` saves a Show more selection before replay. Warm-reload output
includes per-frame sidebar row keys/order hashes, section headers, avatar sources,
and retained cached row elements. These are DOM observations, not pixel paint times.
`--sidebar-view` selects `sessions` (default, with Involving me selected) or `online`.
Run both because current UI presents these inventories in separate sidebar views.
Default reloads use one agent chip; explicit churn scenarios use the all-agent roster.
The Online run also requires the saved sidebar view to survive the reload. If it
returns to Sessions, the run fails instead of reporting Sessions measurements as
Online measurements.
`--runs` accepts 1–20 reloads. `--output` selects the artifact parent.
`--bundle-dir` serves an already built production bundle instead of rebuilding it;
keep its build identity equal to the checkout head. This preserves a baseline
bundle while production sources are edited.

For a boot-weight comparison, use `--bundle-dir <base> --compare-bundle-dir <head>
--runs 20 --untraced --cold-http-cache`. The runs alternate builds and restore
each build's own warm state. Every run records `presentation.firstNonemptyTranscriptMs`
and `presentation.firstEnabledComposerMs` from visible DOM observed on animation
frames; these are readiness observations, not compositor paint timestamps.
Keep profiling and the optional warm-reload probes out of this timing run.
Console progress contains readiness and host load; full RPC and resource records
are serialized to `summary.json` after all runs, outside the preview-server workload.

Add `--thread-cpu-time` to measure consumed renderer CPU with CDP's `threadTicks`
time domain, including in `--untraced` runs. Each result's `threadCpu` records
`scriptMs`, `taskMs`, `layoutMs`, `styleMs`, and whole-thread `threadMs` from just
before reload through settlement (and any requested `--capture-ms` extension).
These are CPU deltas rather than elapsed wall time; later live, streaming, and
session-switch phases retain the same selected time domain. Default runs keep
CDP's `timeTicks` domain.

On a noisy host, run an A/A control before interpreting candidate differences.
First copy the baseline bundle to a separate directory (`cp -R <base> <control>`):
the runner temporarily swaps comparison bundles, so both slots cannot use the same
path. Run `--bundle-dir <base> --compare-bundle-dir <control> --runs 20 --untraced
--thread-cpu-time`. Then replace the comparison bundle with the candidate, keeping
the same fixture and options. Compare CPU deltas alongside readiness and structural
counts; thread CPU does not measure compositor presentation or server work.

`pnpm ui:check-performance --module-attribution --dist <build>` ranks the top
30 emitted JavaScript modules in each route's preload graph. Add `--json` for all
modules and mapping coverage. It gzips source-mapped generated ranges independently,
so those scores identify expensive modules but are not additive transfer costs;
the existing shipped gzip sidecars remain the route budget authority.

Every reload replays the warm visit's persisted sidebar and trimmed v8 transcript
(after unloading the app), local storage and session storage; the HTTP cache stays warm.

`--warm-reload --probe-dir /path/to/probes` adds cache/paint diagnostics. The probe directory supplies `loaf-mutation.init.js` and
`ws-rpc-census.init.js`. The output records cache reads, cached transcript visibility,
hello, live catch-up, enabled input, layout shifts, mutation batches, and retained
row elements. Visibility and enabled-input milestones are DOM observations;
FCP is the browser's paint metric. Diagnostic runs also save filmstrip frames.
Use `--untraced` for timing comparisons without boot tracing or CPU sampling,
then collect separate traced runs for the storyboard and attribution.

`--large-snapshot` expands the transcript to 1,100 synthetic messages (about 3 MB),
including tool results and replay metadata. Combine it with `--warm-reload` to
exercise a large live history with the current bounded IndexedDB restore. `snapshotSave` reports the persisted row count.
`--transcript-messages 400` selects a specific positive message count instead.

`--session-switch` clicks the first recent session after the other measured phases.
It opens another 400-message transcript when paired with `--transcript-messages 400`,
using the same synthetic history and native sidebar navigation. The phase ends once
the target pane and inline preview are visible and pending wire work has been quiet
for 750 ms. It records task/script/layout/style CPU and interval RPCs in `sessionSwitch`,
plus a separate source-mapped `session-switch` profile with `--cpu-profile`.
This measures a first switch to that session in the current document, not a warm return.

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

`live.milliseconds` records Chrome's task, scripting, layout, and style CPU deltas across the
replay. For unprofiled comparisons, divide `ScriptDuration` by `sentEvents` to report scripting
milliseconds per event; keep sampled CPU captures separate.

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

`--selector-stats` adds ranked Chromium selector snapshots to boot captures in
`run-N.selectors.json`, with stylesheet identities, elapsed microseconds, match
attempts, matches, and fast rejects. It requires tracing. The warm interaction
runner (`scripts/bench-control-ui-interactions.ts`) accepts the same flag, plus
`--theme light|dark` and `--thread-cpu-time` for thread CPU duration
metrics on a loaded host. Selector instrumentation adds substantial overhead;
use separate untraced interleaved runs for timing comparisons. Empty Chromium
selector snapshots represent no matching work and are omitted from the ranking.

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

For streaming comparisons, keep both production builds and run complete alternating
cycles with `--bundle-dir <baseline> --compare-bundle-dir <candidate> --runs 20
--streaming-reply --transcript-messages 400 --face chat --untraced`. The benchmark
restores each build's warm state before each run. Streaming comparisons do not
require the separate `--warm-reload` diagnostics or external probe scripts.

Add `--streaming-allocations` to sample JavaScript allocations during the stream
with CDP HeapProfiler at a 4 KiB interval, retaining samples collected by both
major and minor GC. `streaming.allocations` reports estimated bytes and bytes per
delivered delta; `run-N.streaming.heapprofile` retains the allocation call tree.
The interval covers the whole renderer, including synthetic delivery and native
composer input, and excludes reload and report serialization. These are sampled
allocation estimates, not retained heap sizes or exact array counts. Collect
timings in separate runs without allocation sampling.

For concurrent paired comparisons, use separate processes and bundle directories
with the same `--fixture-now-ms` and a future `--live-start-at-ms`, `--runs 1`, and
distinct `--port` / `--sandbox-port` values. The start barrier supports either
`--streaming-reply` or `--live-events` and fails if setup misses the requested time.

Use `--streaming-burst-size 5` to enqueue five snapshots every 166.7 ms
while retaining the average 30 deltas/s. The mock transport still applies
`--frame-gap-ms`; set it to zero to remove intentional spacing, and inspect
delivery timestamps before treating a group as one-frame delivery.
Streaming reports count synchronous
stream assignments, frame publications, pane render calls/time, forced rail
observations, and row ResizeObserver deliveries. These are separate boundaries:
publication is not a rendered commit, and pane render time excludes subsequent
Solid and Markdown work. The source-mapped CPU profile covers that later work;
the task/microtask and next-rAF timings do not measure presentation to the screen.
After timing, each run also checks that the real transcript grew and remains
within two pixels of its native scroll bottom, without manually requesting a render.

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
