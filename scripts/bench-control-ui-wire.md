# Control UI wire benchmark

Measure the production Control UI against an isolated, real Gateway with two
synthetic conversations. The fixture has 120 messages per conversation and
eight deterministic input-replay fingerprints per assistant message. It never
sends a model request or reads the operator's Gateway state or credentials.

Build the UI once, keep the bundle immutable, and prepare a task-owned baseline
checkout with its dependencies installed. Detach both comparison checkouts at
their intended commits: a named development branch renders a badge and loads an
extra font, which would contaminate the comparison. Compare Gateway source changes with
the same UI bundle:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-wire.ts \
  --bundle-dir /absolute/immutable/control-ui \
  --compare-source-dir /absolute/baseline-checkout \
  --profile remote --auth token --pairs 10 --output /absolute/fresh-proof-directory
```

For changes to both Gateway and UI, add `--compare-bundle-dir /absolute/base/control-ui`.
The `base` source then serves that bundle while `candidate` serves `--bundle-dir`.
Omitting it preserves the shared-bundle comparison. To compare two bundles against
the same Gateway source, use `--compare-source-dir .`.

The current checkout is `candidate`; the comparison checkout is `base`. Pairs
alternate AB/BA. Run `--profile local` separately. An A/A control uses the same
checkout for both sides. Without `--compare-source-dir`, `--pairs` repeats the
fixture in one Gateway process. Use a fresh output directory for each command.
Each worker uses a private, temporary `XDG_CACHE_HOME` under the system temporary
directory for secure SQLite snapshot staging and removes it on exit, including
startup failures. Durable synthetic state and proof stay in the output directory.
Use the same `--auth` mode on both sides. `--auth token` uses a fixed synthetic
Gateway token through the normal per-tab session-token setting and exercises
authenticated warm boot. The default `--auth none` preserves the original
diagnostic fixture; do not combine samples from different auth modes.

The network profiles are `local` (unthrottled), `remote` (100 ms application-stream
RTT and shared 10 Mbps per direction), and `mobile` (250 ms RTT and shared 3 Mbps
per direction). Reports retain the numeric limits in `networkProfile`. The mobile
name describes the network, not the viewport or CPU. Add `--extended-flows` to
cover first Board, Usage, and Settings visits plus recovery from a network drop:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-wire.ts \
  --bundle-dir /absolute/immutable/control-ui --profile mobile --auth token \
  --extended-flows --pairs 10 --output /absolute/fresh-proof-directory
```

Comparisons keep one isolated Gateway and browser alive per side. The coordinator
starts those workers serially, then admits one complete sample at a time in AB/BA
order. Every sample still creates a fresh browser context, including fresh caches
and storage; the cold visit prepares that context's warm reload normally. Workers
acknowledge only after writing their sample and closing the context, and remain
idle until the next command. Shutdown waits until both sides finish measuring.
This keeps repeated Gateway startup outside the measurement campaign. The report's
`workerLifecycle` identifies persistent comparisons; do not combine their samples
with earlier per-sample Gateway runs. An explicit `--port`, or two different bundles
served from the same source checkout, retains the sequential worker lifecycle.

The runner copies its instrumentation into the task-owned comparison checkout.
It temporarily points each checkout's `dist/control-ui` at the supplied bundle
and restores the original after its workers exit, including on interruption. Do not use a checkout whose
build or Gateway another process owns. This exercises the normal bundled-asset
cache and precompression policy; configuring a custom UI root would measure a
different policy.

Each sample captures cold chat navigation, an asset-cached chat reload, New
Session navigation, and the first switch to the second conversation. Readiness
is the first animation frame with an authoritative transcript and an enabled
composer, or the enabled New Session input. `transcriptMs` waits for the pane's
authoritative history-ready state. Independently, `transcriptVisibleMs` records
the first visible nonempty transcript row in the selected pane, including a
cached transcript shown before history revalidation. Captures still wait for
authoritative history and the composer. Screenshots are taken outside timed intervals.
Before the warm reload, the runner waits up to sixty seconds for the cold visit's
deferred IndexedDB snapshot write to retain its session identity, delta cursor,
and history state. Token mode also waits for the application's own persisted
boot record, enabling normal early snapshot and validator prewarming; the
runner never fabricates that record. This fixture preparation is outside both
timed intervals; paint and network-idle alone do not prove persistence.

Extended flows use in-app navigation. Board means the second conversation's
Dashboard face, with a loaded empty Board; it does not enable the Workboard
plugin. Usage readiness requires its enabled Refresh control after the initial
read. Settings opens Appearance, since desktop `/settings` redirects to Chat,
and requires an enabled theme control. All three require the matching settled
route as well as their visible ready state. These are first visits in the
existing browser context, not cold direct navigations.

For reconnect, the proxy destroys existing connections and rejects new ones for
five seconds. The runner confirms the app enters its reconnecting phase.
`outageMs` records the actual outage; readiness timing starts at link restoration
and excludes that interval. Readiness requires the connected phase, a fresh
canonical session roster, and the visible transcript and enabled composer.
The wire census must also show a new successful WebSocket upgrade, connect
response, and roster response before readiness, so cached UI alone cannot pass.

The report retains HTTP resource types, encoded transfer sizes, cache status,
response headers, service-worker delivery, and timings. HTTP byte and wire-request
counters are page-observed lower bounds: this page's CDP session does not capture
the service worker's underlying fetches. A `fromServiceWorker` response can come
from a network fetch as well as a cache hit, so it does not set `cached` by itself.
`serviceWorkerResponses` counts those responses separately; cache hits require
CDP cache evidence and zero page-observed transfer bytes. WebSocket entries retain only frame identity,
opcode, compression status, raw/decoded sizes, and timings. Message bodies and
authentication headers are not included. A transparent TCP proxy counts RFC6455
headers and compressed payloads; decoded browser events confirm delivery. The
remote profile shares a 10 Mbps link in each direction and adds 50 ms one-way
delay to HTTP and WebSocket data; mobile uses 3 Mbps and 125 ms one-way delay.
Each direction rotates active TCP flows in
16 KiB transmission quanta; propagation overlaps subsequent transmission.
Backpressure limits source reads, and canceled flows cannot reserve future
bandwidth. This avoids an abandoned speculative preload delaying a reload's
WebSocket reply. All profiles use the same pre-paired synthetic
device and selected synthetic auth mode. The remote and mobile profiles add trusted-proxy address
attribution so the Gateway negotiates its normal remote compression policy;
the local profile uses direct-local transport.

Each sample includes `websocketUpgrades` with upgrade request/response timestamps
and status. HTTP `browserStartedAtMs`, `browserResponseAtMs`, and
`browserFinishedAtMs`, upgrade browser timestamps, and frame `decodedAtMs` share
the action's browser clock, starting at zero. Pair WebSocket requests and responses
by `connection` plus `requestId`; `type` distinguishes requests, responses, and
events. Use those timestamps with transcript/composer readiness to count serial
round trips; `beforeTranscriptVisible` marks delivery before the first visible
transcript row, and `criticalBeforeReady` marks delivery before both authoritative
history and composer are ready,
not proof that every such frame is a dependency. No request bodies or authentication
headers are retained. Frame `atMs` records proxy ingress observation, which can
follow server transmission when the shared link applies backpressure.

Interpret these as synthetic transport and rendering measurements. The proxy
does not simulate TLS, TCP handshake latency, packet loss, or Internet routing.
Decode/hash instrumentation has overhead. Native renderer thread CPU counters
exclude time descheduled by the host. Every action uses a fresh inspector session
so counters cannot accumulate across navigations or earlier actions.
`cpuMs` stops at readiness. `settledCpuMs` and `settledElapsedMs` include the
existing post-readiness drain; compare completed HTTP/RPC work as well as these
counters when earlier readiness changes which background replies arrive first.
`gatewayCpuMs` records process user/system CPU from action start through the
driver's readiness assertion, excluding fixture setup and the post-readiness
tail. It includes Gateway workers, the benchmark driver/proxy, and instrumentation;
it excludes Chrome and other child processes. `gatewayRssBytes` is an advisory
resident-memory snapshot of that same process at readiness, not peak memory.
WebSocket critical-path attribution uses
browser timestamps so delayed automation callbacks cannot move the response
that caused a paint past that paint. Automation-to-assertion time is not INP.
The bounded post-readiness capture also retains secondary traffic, distinguished
from frames delivered before readiness. HTTP transfer sizes include response
headers but exclude request headers; failed/preload-cancelled fetches are retained
separately. Inspect and crop screenshots before sharing: the shell can show
host-derived names even with a synthetic profile and avatar.

For a performance claim, report ten interleaved pairs with median, p95, spread,
and host load. The remote-readiness target is warm transcript visibility within
local plus two RTTs, and session switching within local plus one RTT, with local
median regression at most 5% and no worse p95. On a noisy host,
collect an A/A control and use twenty pairs with renderer CPU and structural
counters. A smaller, clean wire-byte reduction remains useful when it misses
the readiness target; state that gap explicitly.

## Warm navigation policy

The Gateway HTML remains network-first. Authenticated documents are private,
no-store responses containing viewer preferences and scope-filtered bootstrap
configuration. The same chat URL can select a public reader or authenticated app
using current access; the response also carries live terminal and ingress CSP.
Replaying fetched HTML from a service-worker cache could cross these identity,
access, and document-policy boundaries. The worker's integrity-bound generic
shell remains an outage fallback, not an online replacement. An online shell
would also need a fresh-document bypass for the existing build-mismatch reload.
