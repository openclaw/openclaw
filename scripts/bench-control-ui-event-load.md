# Control UI event load

The existing cross-engine harness can keep background sessions active while a
foreground turn executes tools. It uses the production UI and the existing mock
Gateway; it does not measure provider latency or a production server's capacity.

For a bounded typing/scroll/idle comparison, pass `--event-load-interactions-only`.
It omits navigation from the timed workload; the same final status, unread and
history verification still runs after measurement. The default also times
session and route switches.

Build once with `pnpm ui:build`, then run a bounded scenario first:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-engines.ts \
  --steps event-load-unloaded,event-load-0,event-load-5,event-load-20,event-load-100 \
  --engines chromium,webkit,firefox --viewport both --pairs 10 \
  --event-load-duration-ms 240000 \
  --output .artifacts/event-load-screen
```

`event-load-unloaded` has no active turn. `event-load-0` has the foreground turn
only. The remaining scenarios add 5, 20 or 100 active background sessions to the
same inventory. `--event-load-inventory` selects the held roster size (1,000 by default;
use 5,000 for the Team-scale comparison). Setup refreshes the public session
owner to that limit and asserts `heldSessionRows`; changing the fixture alone
would leave the normal 200-row sidebar window. It changes held rows, not active load.
`--event-load-tools` defaults to 200 and
`--event-load-duration-ms` to 240000. Duration is a safety ceiling, not a trailing
wait: measurement ends after the last action. Every loaded action must start and
finish before that ceiling while background work remains active. After the first
live output is verified, trusted typing admits the first half of the foreground
calls. The browser-side scroll loop admits the remainder over its control socket. One producer retains
the six-second total offering rate, pausing between waves if necessary. Every
start, update and result has a nominal deadline; delayed delivery drains that
finite schedule in chronological order without restarting tool lifetimes. The
second wave's clock never depends on how many first-wave events were delivered.
This prevents driver delivery delays
from consuming the entire turn before an action starts. Extending the background
window does not reduce that foreground rate. The longer example keeps background work
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
subsequent receipts use matching-base field patches. The measured session switch
checks the background session's current history. After the measurement window,
terminal receipts and a final revisit verify status, unread state and history.
Every background row must
settle, and all foreground tool results must remain in history. Blank scroll
frames fail the scenario. Failed observations retain partial counters and CPU.

Live snapshots update the external producer's canonical row and history owner, so
list and history replies agree with the event stream. List queries keep the existing
filtering, ordering and pagination owner and refresh it only when queried. Row
delta baselines belong to a connected socket: a replacement connection receives
a full row before its deltas, and disconnected emissions do not advance that
baseline. The observations record opened/closed socket counts; settlement failures
also report close reasons and the rows that did not settle.
The subscription cache follows the socket lifetime too: closing a connection
retires its leases, so releasing a replacement lease restores bodyless broad receipts.

Ground the fixture against the real Gateway before interpreting its results:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-event-load-wire.ts \
  --output .artifacts/event-load-wire
```

This capture starts isolated Gateway state and a loopback synthetic model. Three
real agent runs execute read tools through the normal Gateway and transcript
owners. The observer negotiates the Control UI's event capabilities and subscribes
to one foreground session. Standard output contains event field names, counts
and JSON frame sizes, without authentication frames or message content. The local
`wire.json` also retains sample synthetic payloads and may contain incidental host
or path identity; inspect and redact it before sharing. This validates the wire
mix; it is not a real-provider performance result.

Read per-phase application timing alongside action wall time. Native input
delivery, browser-local settlement and driver round trips are different costs.
Scroll frame gaps describe scripted scrollport movement after a trusted ArrowUp
establishes reader intent, not touch or wheel delivery. The idle interval has no deliberate user action, while Gateway events
continue; it has a separate measurement through the existing engine collector.
Chromium's existing `threadTicks` collector measures main-thread CPU;
WebKit application elapsed time and a separate traced diagnostic are available.
Firefox CPU remains unavailable rather than zero. Scroll delivery time measures
the delay before the in-page loop begins; observed scroll time and rAF gaps then
describe that loop separately. A good median frame gap does not excuse a long
delivery delay or a maximum-frame stall. Native input-to-frame samples are not
a complete INP measurement: inspect the action wall time as well. Only keys
delivered during the typing phase enter those samples; setup disclosure keys
are excluded. Each phase records foreground tools started and completed at its
boundaries. The scroll loop separately records its actual entry and exit counters,
including received foreground/background events. A finite wave may drain during
an action; inspect those counts alongside delivery delay and frames rather than
inferring overlap from the run's active flag.

The real capture also observes shared startup invalidations. Usage invalidation
is coalesced by agent over 500 ms, but none occurred inside the captured short
turns. This workload excludes those unobserved periodic events and small agent
item-boundary events; it models the measured durable, tool and narration paths.

The load producer runs in the Node harness process, outside the renderer. It
owns the timer, row snapshots, message histories, subscription membership and
JSON encoding, and sends event frames over a native loopback WebSocket. The
browser forwards the raw `MessageEvent` data directly to the connection's native
EventTarget listeners. It does not parse, encode or re-schedule native frames
through the cold-load probe's simulated transport; production decoding and event
handling then run normally. Initial RPC/bootstrap fixtures remain the existing mock; this is a
client-event benchmark, not a Gateway capacity benchmark. A separate small
progress frame per producer tick updates observation counters and never reaches
the application. The browser still owns timing/DOM probes and sends foreground
wave admission commands; it does not schedule background events.

`offeredBackgroundHz` is producer durable receipts per elapsed second;
`achievedBackgroundHz` counts those receipts observed at the client's event
listener. `offeredBackgroundFrameHz` and `receivedBackgroundFrameHz` include
status, tool and narration frames; `pendingBackgroundFrames` reports the
producer/client difference at the measurement boundary. Compare like units:
100 active sessions nominally produce 200 durable receipts per second, plus
status and subscription-specific frames. Offered counters are sampled in Node;
client counters stop after an awaited browser observation, so their boundary
can differ by the final delivery batch. Inspect both rates and scheduler lag.
Do not divide scenario CPU by offered events when delivery is behind.

Use a separate `--cpu-profile --engines chromium` run to attribute client work;
the existing source-mapped CPU census excludes the Node producer. WebKit
`--trace` provides application Timeline attribution in a separate run; named
`engine:event-load:<phase>:start/end` marks bound the idle and input phases. Firefox
CPU is unavailable. For per-event CPU, use the one-second idle phase after
foreground tools drain, compare against `event-load-0`, and normalize that
foreground-only idle CPU to the loaded interval before subtraction. Inner and
outer bounds for elapsed time and received frames remain available as
`idleMinimum*`/`idleMaximum*`; retain a CPU/frame range when they differ
materially. Whole-action CPU includes different amounts of background work when
an action takes longer, so use it alongside scroll and input latency rather
than subtracting unequal windows.

For a candidate, use the harness's immutable base, candidate and identical-base
control bundle options. Retain at least 20 rotated pairs plus A/A across the
required engines and viewports before accepting a performance change. Record
host load, median, p95 and spread; do not interpret an effect smaller than A/A
variation as a win. Keep reports under `.artifacts/`, outside committed source.
