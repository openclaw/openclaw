# Control UI event load

The existing cross-engine harness can keep background sessions active while a
foreground turn executes tools. It uses the production UI and the existing mock
Gateway; it does not measure provider latency or a production server's capacity.

Build once with `pnpm ui:build`, then run a bounded scenario first:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-engines.ts \
  --steps event-load-unloaded,event-load-0,event-load-5,event-load-20,event-load-100 \
  --engines chromium,webkit,firefox --viewport both --pairs 10 \
  --event-load-duration-ms 60000 \
  --output .artifacts/event-load-screen
```

`event-load-unloaded` has no active turn. `event-load-0` has the foreground turn
only. The remaining scenarios add 5, 20 or 100 active background sessions to the
same inventory. `--event-load-tools` defaults to 200 and
`--event-load-duration-ms` to 12000. Duration is a safety ceiling, not a trailing
wait: measurement ends after the last action. Every loaded action must start and
finish before that ceiling while background work remains active. The foreground calls are offered over six
seconds after the first live output is verified; extending the background window
does not reduce that foreground rate. The longer example keeps background work
active through navigation on slower baselines. A phase starting after the load
drains fails rather than silently measuring an unloaded action. Terminal receipts
and correctness checks follow outside the measured window. Chromium throttling is a separate run with
`--engines chromium --cpu-throttle 4`. Every browser stays headless.

The background workload uses broad roster receipts, including bodyless durable
message events and status changes. The expanded sidebar can request narration
for up to six running background sessions; these receive stripped tool events,
paced narration and, under the current protocol, durable message bodies. Exact
message subscriptions govern foreground tool events and message bodies. Closing
the sidebar releases its narration interests. First row receipts establish a full row version;
subsequent receipts use matching-base field patches. Terminal receipts and
switching to a previously background session verify status, unread state and
authoritative history after the measurement window. Every background row must
settle, and all foreground tool results must remain in history. Blank scroll
frames fail the scenario. Failed observations retain partial counters and CPU.

Ground the fixture against the real Gateway before interpreting its results:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-event-load-wire.ts \
  --output .artifacts/event-load-wire
```

This capture starts isolated Gateway state and a loopback synthetic model. Three
real agent runs execute read tools through the normal Gateway and transcript
owners. The observer negotiates the Control UI's event capabilities and subscribes
to one foreground session. Output contains event field names, counts and JSON
frame sizes, with no authentication frames or message content. It validates the
wire mix; it is not a real-provider performance result.

Read per-phase application timing alongside action wall time. Native input
delivery, browser-local settlement and driver round trips are different costs.
Scroll frame gaps describe scripted scrollport movement, not touch or wheel
delivery. The idle interval has no deliberate user action, while Gateway events
continue; it has a separate measurement through the existing engine collector.
Chromium's existing `threadTicks` collector measures main-thread CPU;
WebKit application elapsed time and a separate traced diagnostic are available.
Firefox CPU remains unavailable rather than zero. Scroll delivery time measures
the delay before the in-page loop begins; observed scroll time and rAF gaps then
describe that loop separately. A good median frame gap does not excuse a long
delivery delay or a maximum-frame stall. Native input-to-frame samples are not
a complete INP measurement: inspect the action wall time as well.

The real capture also observes shared startup invalidations. Usage invalidation
is coalesced by agent over 500 ms, but none occurred inside the captured short
turns. This workload excludes those unobserved periodic events and small agent
item-boundary events; it models the measured durable, tool and narration paths.

The mock producer runs inside the measured renderer. Its producer and delivery
elapsed diagnostics overlap application work and cannot be subtracted as CPU.
Use a separate `--cpu-profile` Chromium run to attribute this cost. Divide the
matched foreground-only idle CPU difference by received background events during
that same fixed idle interval for an incremental CPU/event estimate. Whole-action
CPU includes different amounts of background work when an action takes longer;
do not divide total scenario CPU by offered events or subtract unequal windows.

For a candidate, use the harness's immutable base, candidate and identical-base
control bundle options. Retain at least 20 rotated pairs plus A/A across the
required engines and viewports before accepting a performance change. Record
host load, median, p95 and spread; do not interpret an effect smaller than A/A
variation as a win. Keep reports under `.artifacts/`, outside committed source.
