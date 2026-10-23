# Control UI retention census

Run against an already built production renderer. This is an opt-in memory
workload, not part of routine UI tests. Playwright runs on Node; the application
uses the production Solid runtime, native clocks, and synthetic Gateway data.

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
catalog page/dialog state, 2,000 streaming deltas, and ten reconnects. Each
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

`census.json` records post-GC JS heap, native DOM counters, detached native DOM
nodes and shallow bytes, live/disposed Solid owners, global event listeners by
event type, and active timer/interval IDs. The timer probe retains IDs only.
Before each GC the mock's request log is cleared and its count recorded; it must
not masquerade as product retention. Heap measurements still include other
mock/probe state. Owner counts use the installed rc.16 production object shape;
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
