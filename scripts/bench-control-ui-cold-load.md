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

The selected agent has 300 sessions with a 200-row first page, 30 pinned dashboards
outside that page, 34 owners, 120 people, six agent identities, six UI plugins,
240 transcript messages, and 12 inline widgets. Six catalog-host events and twelve
full presence snapshots arrive individually. Catalog notifications exercise the data
owner; the grouped agent roster does not display catalog rows. Widgets use the production sandbox
host on a separate loopback listener. Plugins are small synthetic modules exercising
registration/loading, not replicas of any private plugin implementation.

`--latency-ms` sets the inbound message delay (default 35 ms). `--frame-gap-ms`
sets the minimum separation between Gateway message deliveries (default 4 ms).
Concurrent requests remain concurrent; replies share one serialized wire.
`--sidebar-view` selects `sessions` (default, with All owners selected) or `online`.
Run both because current UI presents these inventories in separate sidebar views.
The Online run also requires the saved sidebar view to survive the reload. If it
returns to Sessions, the run fails instead of reporting Sessions measurements as
Online measurements.
`--runs` accepts 1–20 reloads. `--output` selects the artifact parent.
`--bundle-dir` serves an already built production bundle instead of rebuilding it;
keep its build identity equal to the checkout head. This preserves a baseline
bundle while production sources are edited.

`--warm-reload --probe-dir /path/to/probes` explicitly flushes the selected transcript
through its cache owner before each reload and verifies that session's persisted
snapshot. The probe directory supplies `loaf-mutation.init.js` and
`ws-rpc-census.init.js`. The output records cache reads, cached transcript visibility,
hello, live catch-up, enabled input, layout shifts, mutation batches, and retained
row elements. Visibility and enabled-input milestones are DOM observations;
FCP is the browser's paint metric. Diagnostic runs also save filmstrip frames.
Use `--untraced` for timing comparisons without boot tracing or CPU sampling,
then collect separate traced runs for the storyboard and attribution.

The dashboard fixture includes reaction pickers, widget actions, context usage,
and viewers. Use `--warm-reload` to measure its cached restore. Transaction labels
in diagnostic traces distinguish transcript, sidebar, and composer cache
completions; a completion callback can include later render microtasks and is
not a measurement of native IndexedDB cost alone.

`--live-events` adds 125 synthetic live frames over 20 seconds after each reload
settles. The stream mixes full presence snapshots, session patches for displayed,
held-but-hidden, and outside-window rows, open-session messages and assistant
streaming, changing catalog hosts, and unrelated cron/run-state activity. The live
phase runs after tracing and CPU sampling stop. The selected session starts with an
active canonical run; live messages and deltas advance its history receipt before
publishing the event, so later history reads retain the same messages and stream. Capture ends after all frames
arrive and the planned 20-second stream plus 750 ms have elapsed; busy sessions
need not become idle. `plannedWindowMs` and the observed `elapsedMs` distinguish
the planned window from delayed delivery on a loaded host. Its `run-N.live.json` records Lit
updates and bounded `requestUpdate` scheduling stacks per event label, plus DOM
snapshots of the affected rows, chat viewers, and streaming text; `run-N.live.png`
shows the synthetic final state. Row attachment and viewport visibility distinguish
an absent row from a rendered row below the fold.

For the Solid sidebar, `solidSidebar.lifecycle` separately counts owner
`requestUpdate` invalidations and `prepareRender`/`commitRender` projection lifecycle
passes. Bounded owner and session-data origin stacks identify their callers. These
are not full Solid render counts: fine-grained bindings update independently. The
init probe captures the existing host-to-owner WeakMap registration, restores that
tap immediately, and restores the owner wrappers at the end of the live phase.
A missing Solid owner fails the capture instead of reporting zero work. Lit tags
retain their original per-tag `performUpdate` counters; zero Lit updates for a
ported Solid tag are a measurement gap, not a performance improvement.

`solidChat` counts every page/pane owner request, owner publication, actual
projection `render` read, pane prepare/commit, and page after-commit call separately.
Each projection pass retains the pending producer stacks and request IDs, including
requests coalesced by the owner. IDs remain attached to their publication batch,
so a request that drives an early projection and a later queued publication is
visible on both passes. Unattributed passes and remaining pending producers are
explicit. Existing lifecycle hook notifications distinguish owner facts from
element invalidation/commit notifications; their combined count is not a DOM
commit count. The probe preserves and restores the hook's complete descriptor,
including the existing test adapter's accessor, along with all owner methods.
These are projection/lifecycle counts, not all fine-grained Solid binding work.

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
JavaScript stacks, Lit updates per tag, source-mapped CPU self-time hotspots,
Solid flush self/inclusive sampled time, and RPC request/response bytes. The top
20 CPU entries retain browser/GC overhead alongside source-attributed call sites.
A reload settles after all scheduled fixture events and outstanding RPCs complete,
then 750 ms with no wire, Lit, or captured Solid sidebar lifecycle activity. That quiet interval is measurement padding,
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
