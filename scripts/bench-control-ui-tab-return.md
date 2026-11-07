# Hidden work and tab return

`bench-control-ui-tab-return.ts` extends the Control UI engine benchmark tools
with incoming work while hidden and shared-origin tabs. It uses the production
HTTP bundle, the existing synthetic Gateway fixture, resource counters, engine
metrics and action timing. All browser windows stay headless.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-tab-return.ts \
  --bundle-dir dist/control-ui --engines chromium,webkit,firefox \
  --minutes 1,5,30 --tabs 1,2,3,4,5 --modes stream,sessions,disconnect \
  --output .artifacts/tab-return/census
```

Build once with `pnpm ui:build` first. `--pairs N`, `--compare-bundle-dir` and
`--control-bundle-dir` rotate the base, candidate and identical-base control
positions. Keep builds and output on the campaign's approved proof volume.
For a performance change, use at least 20 rotated pairs with an A/A control;
a setup smoke is not timing evidence. `--trace` collects WebKit elapsed script
and layout intervals separately from untraced application latency. Chromium's
ordinary metrics use renderer main-thread CPU (`threadTicks`).

Each simulated minute delivers 60 growing reply snapshots, with one completed
tool per minute. MessageChannel task boundaries allow reactive settlement
between events without hidden browser timer throttling changing the workload.
This compresses event arrival: it does **not** model elapsed-time expiry, natural
stream cadence, network throughput, or provider latency. The disconnect case
explicitly closes the synthetic socket and restores connectivity on return;
it does not prove silent socket-loss detection.

With one tab the page is hidden throughout delivery. With two to five tabs,
one page stays active and all receive the same fixture events. The returning
page then exercises native typing and session navigation while its peers remain
hidden. Per-tab resource and CPU endpoints expose cross-tab storage wakeups.
The tabs share an origin and browser storage, but the synthetic sockets remain
realm-local. This workload cannot establish the browser's real WebSocket
connection limit, Gateway fanout cost, or server-side subscription filtering.

For a bounded real-transport check, run the companion against the same built
bundle. It starts an isolated loopback Gateway with a synthetic streaming
inference provider, then checks one and five native Chromium tabs:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-tab-return-native.ts \
  --bundle-dir dist/control-ui --output .artifacts/tab-return-native
```

The companion matches the selected bundle's build metadata against each native
client's build ID. Gateway deliberately removes the document cache stamp when
serving a custom root, so that stamp is recorded but not required. It
records distinct authenticated connection IDs, native visibility, final
delivery/rendering, and hidden-peer CPU during active typing. In the one-tab
case, it also asserts that outbound `sessions.patch` requests with `unread: false`
for the target session do not increase from confirmed hidden visibility through
the final-event endpoint. This checks read acknowledgement requests, not settled
unread state. Five connected tabs establish a lower bound of five connections,
not a browser maximum. It is a single-sample count/CPU smoke, not comparative
performance proof; it does not prove OS/push notifications.
Synthetic Gateway state and the browser profile are removed after cleanup;
the report and logs remain under `--output` on the chosen proof volume.

Visibility mechanisms are recorded explicitly:

- Chromium: the existing full Chrome for Testing launcher with `noDefaults`,
  native window minimization for one tab and native tab activation for peers.
- WebKit: its existing in-process native page-proxy test-activity command. This
  changes `document.visibilityState`, fires `visibilitychange`, and stops native
  animation frames; it is not OS window minimization or a JavaScript getter stub.
- Firefox: the pinned automation runtime forces active documents. Hidden cases
  are reported as unsupported, never measured with simulated visibility.

The report retains hidden/reveal resource endpoints, uncollected heap use when
available, return application latency, three return frames, Long Tasks API
observations, and native typing/switch timing. Unsupported counters are `null`.
The Long Tasks API reports only tasks of at least 50 ms. Heap changes without GC
are allocation/retention observations, not proof of a leak. Screenshots contain
only the synthetic fixture and are captured on the first pair or failure.

For a separate retention diagnostic, add `--collect-garbage --engines chromium`.
This collects garbage through `HeapProfiler.collectGarbage` immediately before
every heap/resource endpoint: before work, while hidden, after return, and for
peer tabs. The manifest records `collectGarbage: true`. This mode rejects WebKit
and Firefox; it is never timing acceptance evidence because collection changes
the measured workload and collector timing. Ordinary runs keep their existing
uncollected measurements.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-tab-return.ts \
  --bundle-dir .artifacts/tab-return/base-bundle --compare-bundle-dir dist/control-ui \
  --engines chromium --collect-garbage --minutes 1,5,30 --tabs 1,5 --modes stream \
  --output .artifacts/tab-return/retention
```
