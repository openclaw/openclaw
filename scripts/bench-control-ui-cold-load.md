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

Each invocation keeps its exact Git head and dirty-tree inventory, raw Chrome trace,
CPU profile, settled screenshot, and JSON summary in a fresh timestamped directory.
It measures renderer-main-thread task interval union, long tasks, layouts with
JavaScript stacks, Lit updates per tag, source-mapped CPU self-time hotspots,
Solid flush self/inclusive sampled time, and RPC request/response bytes. The top
20 CPU entries retain browser/GC overhead alongside source-attributed call sites.
A reload settles after all scheduled fixture events and outstanding RPCs complete,
then 750 ms with no wire or Lit activity. That quiet interval is measurement padding,
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
