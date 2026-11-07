# Interrupted navigation

`bench-control-ui-engines.ts --steps rapid-navigation` exercises input sequences
without waiting for each intermediate destination to finish. It uses the production
bundle, native browser clocks and synthetic Gateway fixtures. It does not measure
live Gateway or provider latency.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --bundle-dir .artifacts/base-bundle --compare-bundle-dir dist/control-ui \
  --control-bundle-dir .artifacts/base-bundle --pairs 20 \
  --engines chromium,webkit,firefox --viewport both \
  --steps rapid-navigation --output .artifacts/rapid-navigation
```

Use `--cpu-throttle 4 --engines chromium` for the throttled matrix. WebKit and
Firefox do not expose equivalent CPU throttling. Use
`--network-profiles rtt-100ms` to delay HTTP requests. Rapid scenarios retain
their immediate synthetic Gateway replies; they do not inject the boot/page
scenarios' Gateway frame delay. This isolates slow lazy chunks from RPC latency;
keep these results separate from localhost. The scenario IDs in `manifest.json`
can be passed individually to `--steps` for a focused comparison.

The catalog includes five and twenty session clicks at 50, 150 and 400 ms target
intervals, long transcripts, direct-destination controls, native model and session
search arrows, cold/warm Devices-to-Automations navigation, back/forward, early
menu/drawer closure, typing during session arrival, earliest available typing on
reload, and draft/scroll restoration after a burst.

Two additional diagnostics are selected only by their explicit IDs:
`rapid-cached-admission-direct` and `rapid-cached-admission-leave`. They persist
a real session snapshot, hold its first IndexedDB open, then release it while
the original pane is current or after navigating away. The production 100 ms
admission deadline is unchanged; missing that pending window fails setup. The
leave case records hidden-pane admission as work so the baseline can expose it.

Session clicks use native pointer input at current hit-tested coordinates. Bringing
a row into view and reopening the mobile drawer are included in the workload.
Input deadlines never wait for content readiness, but actual delivery can miss
them. Each sample records delivered gaps, deadline lateness and, where the event
clock permits, native event-to-handler delay. Lateness includes driver overhead
and is not isolated input queue delay or INP. Route cases include native sidebar
clicks from System status to Automations and an explicitly non-native
Devices-to-Automations control that isolates loader supersession; history calls
are marked non-native. The sidebar has
no arrow-selection contract; the session keyboard case uses command-palette
results. Reload typing begins in the static boot composer and verifies the
complete draft after that element hands off to the connected session.

The final-input metric ends after two consecutive animation-frame observations
of the correct destination and content. It is application readiness, not paint.
Observation continues for 250 ms (one second for route replacement) to catch late
requests and stale content. Total CPU and longest tasks include that tail. The
harness reports the largest Long Tasks API entry; zero means no reported task
over its 50 ms threshold, not zero task time. The harness cannot attribute CPU
to individual abandoned owners. ResourceTiming
counts completed chunks, not requests still in flight. Missing WebKit/Firefox
CPU or Long Tasks support remains unavailable rather than zero.

Compare a candidate with the same base and a base/base control in rotated order.
Performance acceptance needs twenty pairs, at least a 5% improvement in the
target flow, and no attributable direct-click or sibling regression beyond the
campaign's timing band. Preserve failed samples and correctness failures even
when timings improve. A short smoke run establishes collection and behavior,
not a performance result.
