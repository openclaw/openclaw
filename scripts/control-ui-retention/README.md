# Control UI retention census

Run against an already built production renderer. This is an opt-in memory
workload, not part of routine UI tests. Playwright runs on Node; the application
uses the production Solid runtime, native clocks, and synthetic Gateway data.

For a mixed working-day soak in one page lifetime in both engines, use the
cross-engine harness:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts --steps memory-working-day --engines chromium,webkit --viewport desktop --output .artifacts/memory-working-day
```

It switches through 200 distinct sessions, completes 50 streamed turns, visits
the workspace and Settings pages, refreshes Board and Usage, opens/dismisses the
model picker and command dialog, and reconnects ten times. Each round ends on New
Session before the existing retirement drain and two GCs. Compare rounds 5–10:
the target is at most 10% heap and DOM growth, with stable active resources.
Chromium reports native DOM/listener counts and heap detachedness; WebKit reports
reachable heap bytes, DOM wrappers and their resolved connectedness, and engine
memory categories. WebKit wrapper counts are not total native DOM counts, and
neither engine's forced-GC samples simulate operating-system memory pressure.
The mock releases closed transports while preserving connection-history metadata;
its request history is cleared at each checkpoint.

The bounded dependency probe does not need an application build. It bundles the
installed runtime in production, development, and observe modes and uses a fresh
Chromium document for each, so the first-select retention cannot hide behind a
warm runtime. Run only this file with:

```sh
OPENCLAW_VITEST_RUNTIME=node node scripts/run-vitest.mjs run --config scripts/control-ui-retention/vitest.config.ts --configLoader runner scripts/control-ui-retention/dependency-retention.test.ts --maxWorkers=1
```

The Node override is required for Playwright. After disposing the rendered
select, two explicit collections must release both it and its form; a separate
unowned object checks that collection actually ran.
The second probe disposes an unobserved pending computation with no subsequent
reactive work. Its payload and root must collect while the scheduler is idle. The
third probe rejects an async source while idle, then disposes an unobserved reader
in a second root. Status propagation can queue that reader without a staged flag;
its payload and root must still collect while the source root remains live. An
explicit `flush()` is a no-op when no work is scheduled. A separate regression
requires a rejected async replacement to clean up its previous committed frame.

```sh
pnpm ui:build
OPENCLAW_VITEST_RUNTIME=node node scripts/run-vitest.mjs run --config scripts/control-ui-retention/vitest.config.ts --configLoader runner --maxWorkers=1
```

`OPENCLAW_RETENTION_BUNDLE` chooses another production bundle. Set
`OPENCLAW_RETENTION_FILTER='^(session-switch|stream|reconnect)$'` for the long
session workloads, or a catalog scene ID such as `^route-usage$` for one page.
`OPENCLAW_RETENTION_OUTPUT` chooses the artifact parent. Each run creates its
own directory and retains failed attempts.

The census measures two successive blocks of 50 distinct session switches, ten visits to each
catalog page/dialog state, 2,000 streaming deltas, ten reconnects, 100 distinct
session hover intents followed by cached reuse after the cooldown, ten full long-session scrolls, and ten minutes each of
visible and hidden idle. Use `OPENCLAW_RETENTION_FILTER='^(intent-prefetch|long-session-scroll|idle-visible|idle-hidden)$'`
for the added performance workloads. Hidden idle minimizes a fresh, runner-owned
Chromium window; it requires a windowed host and never fakes visibility or freezes
the renderer. Each
SPA page/dialog gets its own browser context, and all ten visits use the same
document: a reload cannot hide leaked owners. The `document-*` cases cover
boot-only Gateway confirmation and standalone approval/question documents by
navigating within one retained browser context and CDP session. Those cases
measure document retirement separately; timer/global-listener counts describe
the current document while heap snapshots include retained older documents. An initial visit warms lazy code
and caches. MCP warms its App first and opens ten confirmations total to honor
the native prompt limit; compare its second five-visit block. Browser-auth
recovery preserves its native 30-second throttle and has a ten-minute deadline. Samples follow a 4.1-second drain of intentional retirement and
feedback timers, two animation frames, and two explicit GCs.
Hidden samples skip animation-frame settlement because minimized windows can
pause it. Each workload uses a fresh browser process to isolate native teardown
failures; headless runs disable GPU rendering. A failure still fails its workload.

`census.json` records post-GC JS heap, native DOM counters, detached native DOM
nodes and shallow bytes, live/disposed Solid owners, global event listeners by
event type, and active timer/interval IDs. It also records cumulative timer
callbacks and CDP task/script/layout/style duration, so idle wakeups can be
compared over the same interval. The timer probe retains IDs only.
Named string-keyed cache maps (`lastAttemptAt`, `revisions`, `readScopes`, `hydratedSnapshots`)
report key counts and shallow key/table bytes from the heap snapshot. These
bytes overlap other totals and exclude referenced values; they are not retained
heap size. V8 compilation can grow heap even while DOM and live owners plateau.
Before each GC the mock's request log is cleared and its count recorded; it must
not masquerade as product retention. Heap measurements still include other
mock/probe state. Owner counts use the installed rc.18 production object shape;
unknown flags are reported, never silently counted as live. These metrics are
report-only until repeated evidence supports a stable budget.

Every sample retains a CDP heap snapshot. To rank strong retained growth and
inspect its owning paths, use the existing analyzer on samples from the same
uninterrupted browser context:

```sh
node scripts/heap-snapshot-diff.mjs <before.heapsnapshot> <after.heapsnapshot> --json --top 15
```

Report bytes per cycle only over the matching interval (50 switches, five
visits, 500 deltas, etc.). Constructor retained totals overlap; do not add them.
Warm caches, the retained Chat page, and delayed retirement are not leaks.
Compare later samples for a plateau before changing their owners.

The manifest records build identity, host load, measurement contract, and
coverage limits. The page inventory reuses the parity catalog. Additional dialog recipes cover
resource pickers, plugin consent, memory tools, onboarding, file/private/auth
recovery states,
and the official MCP App SDK confirmation flow. These use the production
renderer with synthetic transport; they do not prove real Gateway behavior.
The manifest names remaining coverage limits, including boot-only and standalone
documents. Native OS pickers, the Linux companion renderer, and arbitrary
third-party dialogs have separate ownership.
