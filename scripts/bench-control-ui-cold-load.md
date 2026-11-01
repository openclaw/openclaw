# Team-scale Control UI cold-load benchmark

## Low-memory mobile profile

Both `bench-control-ui-cold-load.ts` and `bench-control-ui-interactions.ts` accept
`--low-memory`. This starts Chromium in low-end-device mode with a 128 MiB V8
old-generation limit and records the profile in the report. It does not impose
an Android OS/process RSS limit or emulate a physical Android WebView. Pair it
with `--viewport mobile --cpu-throttle 6`; keep the memory profile identical in
the unthrottled control. For slow-4G boot delivery, use
`--network-latency-ms 150 --download-kbps 1600` in the cold-load runner. Static
HTTP delivery and synthetic Gateway RPC delays remain separate measurements.

Use untraced runs for ranking and interleaved base/control/head comparisons,
then a separate `--trace` interaction run to attribute an expensive cell. On a
busy host, repeat with `--thread-cpu-time` to distinguish renderer CPU from
descheduling. Multi-action scenarios report aggregate task time, not per-event
input latency.

## Cold route CSS coverage and rendering cost

`bench-control-ui-css.ts` serves already-built base and head bundles through the
production Gateway HTTP handler with the deterministic team-scale RPC fixture.
It serially interleaves base, identical-base control, and head (reversing the
triplet on alternating pairs), using a fresh browser context and cold HTTP cache
for every direct navigation. The default matrix is Chat, New Session, Sessions,
and Settings Appearance × desktop/mobile × light/dark × 1×/4× CPU. Settings uses
`/settings/appearance`: desktop `/settings` redirects to Chat. Readiness requires
the matching successful route, no pending route, the requested theme, and the
enabled composer plus transcript text, a session table row, or a theme tile, as
appropriate, across two animation frames. Chat also waits for the visible final
inline metric's nested sandbox content and fonts. Every route then settles the
parent document's fonts and two animation frames before stopping metrics, so
blank embedded fixtures and late font layout cannot look like performance wins.
Reports retain shell-ready and complete-screen-ready wall times separately.
The renderer's `threadTicks` clock
reports script/task/style/layout CPU and style/layout counts; browser navigation
time to readiness remains wall time. Reports include raw samples, median/p95 and
range, host load, CSS resource counts/sizes, build identity, and first-pair
screenshots. The readiness probe's frame/geometry checks and the short CDP
collection tail are included consistently in every CPU sample.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-css.ts \
  --bundle-dir /absolute/base/control-ui --compare-bundle-dir /absolute/head/control-ui \
  --pairs 10 --output /absolute/proof/css-local
```

Repeat with `--network-latency-ms 100` for HTTP at 100 ms latency/10 Mbps. Filter
with `--routes chat,new,sessions,settings`, `--viewports desktop,mobile`,
`--themes light,dark`, and `--cpu-rates 1,4`. Run a separate `--coverage --pairs 1`
pass to retain raw stylesheet text and Chromium used ranges through asserted
readiness; its instrumented timings are not performance evidence. Used ranges
record rules observed during boot, including earlier transient states, rather
than proving every selector in a rule matched the final screen. Zero coverage is
not deletion authority: inactive routes, states, pseudo-classes, media queries,
and shadow roots require source/consumer audits and their own behavior coverage.
Screenshots disable animations after measurement; inspect them
before sharing. Service workers are blocked, immutable server asset caches stay
warm, and RPC/bootstrap/plugin data are synthetic. HTTP throttling does not add
RPC latency, so these results describe CSS delivery and renderer cost, not live
Gateway/provider performance. Use the A/A control and 20 pairs with CPU metrics
when shared-host wall timings are noisy.

## Cold routes and dependency leaks

`bench-control-ui-route-leaks.ts` visits selected routes in fresh browser contexts,
with the HTTP cache disabled and service workers blocked. It serves immutable
production bundles through the Gateway HTTP handler and uses synthetic Gateway
responses. Coverage runs record requested chunks, source-map modules, import
initiators, and V8 executed versus unexecuted bytes, including preloaded modules
that were never evaluated. Requested source bytes and completed/evaluated bytes
are separate: a preload still transferring at readiness is not a completed load.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-route-leaks.ts \
  --bundle-dir /absolute/base/control-ui --compare-bundle-dir /absolute/head/control-ui \
  --mode coverage --profiles local --output /absolute/proof/routes
```

Use `--routes sessions,cron,usage` to narrow the inventory. Timing runs are
separate from coverage instrumentation: `--mode timing --pairs 20 --profiles
local,remote` interleaves base, a second base control, and head. The remote profile
adds 100 ms HTTP latency at 10 Mbps; synthetic WebSocket responses have no RTT.
Reports retain readiness, thread-clock script/task CPU, host load, and each failed
or unsupported scenario. Usable route readiness requires a loaded route and a
visible usable control; sharing additionally opens its menu. Compare medians and
p95 against the A/A control before attributing timing changes on a loaded host.

Use `--routes agents,cron --interactions agents-files,cron-history,cron-transcript`
for the corresponding follow-through probes. Their automation-to-ready wall and
CPU intervals are separate from cold readiness; they are not INP measurements.
Coverage mode also records which requested modules actually evaluated during
each action. Transcript probing opts into a synthetic completed run and messages.
Every matching Agents/Cron variant receives at least 2,000 ms of post-ready
think time, including builds without passive preloads. When the built navigation
descriptor provides `agents-next` or `cron-next`, the probe also waits for those
byte preloads. It records the actual warmup wall time and CPU for every variant;
preload completion may extend the window. Coverage mode records V8 evaluation
and rejects a panel that evaluates before its action. Cold readiness and
coverage remain bounded before this optional warmup.

Use `--routes advanced --interactions settings-security-immediate` or
`settings-security-idle` for one independent native Settings → Security visit.
Run each action in its own command and fresh contexts; do not combine them.
The idle case has a fixed 2,000 ms post-ready minimum and does not wait longer
for preloads. Both record actual modulepreload links, resource completion,
config/schema receipt counts, and V8 evaluation before/after the native click.
Security readiness requires its checked Browser toggle and four enabled tool
profiles with no override selected. The action precedes artifact analysis and
screenshots; `readinessToActionMs` records observation/automation overhead.
Cold Advanced coverage remains frozen at its own readiness. Use separate
coverage and timing runs, both localhost and 100 ms HTTP, with the same A/A
control and CPU rules above. HTTP shaping does not add synthetic RPC latency.
A route's declared next interaction is its only automatic idle choice; after
it completes, New Session still warms on intent or on routes without a declaration.

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
  --engine chromium --pairs 10 --output /absolute/proof/media
```

Repeat with `--engine webkit` for the same media workload in WebKit. Chromium
is the default; WebKit records wall timings, request counts, blob lifetimes, and
feature-detected layout shifts without CDP CPU, heap, or trace metrics. Unsupported
native Layout Instability is recorded as `nativeLayoutShiftSupported: false` and
null values for `layoutShiftSum`, `mediaAttributedShiftSum`, and
`maxSessionWindowShift`; it is never presented as zero shifts.

The observer resets immediately before held media is released. Each `stable`,
`scrolled`, and `disposed` snapshot retains all non-recent-input events since that
reset. `layoutShiftSum` adds their values; `mediaAttributedShiftSum` adds whole
events with at least one media-containing source, which does not establish that
media caused the entire event. `maxSessionWindowShift` records the largest window
sum, starting a new window at a gap of at least 1,000 ms or a duration of at least
5,000 ms. This reset-bounded score is not navigation-lifetime Web Vitals CLS.
`layoutShiftPhaseSums` reports the load sum and additional scroll/disposal sums
from those existing snapshot boundaries. Legacy artifacts retain their old
`cls`/`mediaCls` cumulative sums; derive a window score from their raw `shifts`
rather than relabeling those values.

Use `--dimensions canonical` to include the persisted `__openclaw.media` image
width/height and inline slot mapping. The default `--dimensions missing` preserves
the original metadata-free cohort. Compare the same cohort on base and head;
known-dimension reservation cannot prove zero shift for absent dimensions.

For attribution, add `--geometry --pairs 1` in a separate diagnostic run. It captures
all DOM element rectangles before and after the held-media release, including
row keys, classes, scroll geometry, and image decode dimensions. During that
fixed-viewport load interval only, an rAF sampler records changed visible
transcript row, image, frame, footer, and footer-descendant rectangles with
timestamps and source classes. Insertions and removals have a null previous or
current rectangle. Sampling stops before scrolling; these rectangle changes are
not a synthetic CLS score. The geometry reads add layout work, so do not mix
these diagnostic timings with uninstrumented timing runs.

The initial viewport is settled while media is held. Releasing those requests
records the load-phase shifts before scrolling. Each measured phase allows
intersection admission frames, then waits for all admitted media HTTP requests
and visible loading images/favicons across two settled frame checks; unadmitted
off-screen placeholders do not block. The runner then scrolls the
transcript and online roster, remounts the first/last rows, and removes the native
`openclaw-app` host to exercise production disconnection while preserving the
document for lifetime measurement. Settings parks chat and cannot prove disposal.
A document nonce assertion rejects any reload as invalid disposal evidence.
Per-sample JSON records browser request events by full URL (including revision, ticket,
and size queries), method, kind and opaque auth-context identity; credentials are
never recorded. Cumulative before/stable/scroll/disposal snapshots and separate
boot/steady duplicate counts distinguish request ownership from bootstrap work.
`cacheProbe.serverRequests` separately records actual HTTP admissions.
`cacheProbe.fetchAttempts` separates `cacheOnly` (`only-if-cached`) thumbnail probes
from `networkEligible` fetches and records their cache mode, request mode,
credentials mode, opaque authorization identity, and outcome. Correlate these with
server admissions by exact URL and method; fetch authorization identities are
independent of browser request contexts, which also include cookies.
`cacheProbe.networkDownloads` is `null`: HTTP admissions do not establish complete
download bytes. Browser request events include cache hits and failed requests;
cache-only probes must not reach the server. A repeated browser event cannot by
itself prove a repeated network transfer. The native HTTP fixture serves bounded
WebP thumbnails and the original full-image PNG; earlier routed-media workloads
are not directly comparable.
Chromium duration metrics use its `threadTicks` clock to measure thread CPU time,
excluding time descheduled by other work on the host. Wall-clock load/scroll
timings remain separate.

It also records native layout-shift source rectangles, timestamps, and media attribution when
the engine supports Layout Instability, object URL
creation/revocation and remaining DOM consumers, CDP script/task/layout/style
duration, and JS heap before scrolling and after forced GC immediately before
and after host disconnection, including unreferenced favicon blob URLs. The
first pair includes pending and loaded screenshots for each bundle/profile.
`summary.json` retains every sample, load
average, bundle identity, and median/p95 load/scroll timings.

Acceptance is zero CLS in the fixed media viewport and no live object URLs owned
only by disposed markdown consumers. Review repeated admissions alongside cache-only
probes before attributing application reuse. Review retained URLs against their actual owner: a documented shared
page-lifetime cache is distinct from a disposed consumer leak. Timing needs ten
pairs with median regression ≤5% and p95 not worse. On a loaded host, repeat with
the same base directory supplied as both bundles for an A/A control, then use
20 interleaved pairs and CDP CPU plus structural counters if wall timing is noisy.

Use a separate Chromium `--trace --pairs 1` run for decode/paint attribution; tracing adds
overhead and must not be mixed with the untraced timing samples. The trace and
named-event duration sums are retained per sample. CDP JS heap excludes native
decoded-image/GPU memory. The mock RPC transport has no RTT; Chromium static HTTP
uses CDP throttling, while WebKit static HTTP is unthrottled. Both engines use
the same explicit routed-media delay because Playwright fulfillment bypasses
network emulation. Load measurement starts after static assets are ready; this
is not a cross-engine cold-navigation comparison. Routing disables the HTTP cache, so duplicate counts
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
Cold New Session omits owner registration and sidebar counters because it has no
Chat owner to finish registration. The effective `ownerProbes` and
`sidebarCounters` flags are recorded in `summary.json`; other routes and warm
reloads retain their existing instrumentation.
Browser storage and HTTP caches are cleared between samples; Gateway asset
caches stay warm for each immutable bundle. Each bundle's index is read before
sampling to initialize the shared file reader outside the first timed reload.
The WebSocket/bootstrap fixtures
remain synthetic, so this measures the production HTTP and renderer paths,
not Gateway RPC or provider latency. The default Vite preview server does not
activate Gateway route preload hints or serve the shipped compression sidecars;
retain that mode for renderer diagnostics rather than network-readiness claims.

Add `--critical-path-intent-ms 150` to hover and focus the destination for a
150 ms dwell before activation. Settings uses its real identity-menu item in
this mode; without the option it retains the keyboard-shortcut entry point.
`elapsedMs` remains activation-to-ready. `intentElapsedMs` includes hover/focus,
the dwell, and activation-to-ready, while `intentDwellMs` records the actual
pre-activation interval. The `critical-path:<route>:intent` mark and interval
RPC/resource records retain work started during intent, including requests that
finish before activation; `carryInRpcCount` counts requests begun before
activation. CPU collection also starts before intent. Each destination still
starts from a separately settled chat boot, so this measures first route visits,
not direct cold route loads or retained return visits.

Each destination's `criticalPath[].presentation` records layout shifts from
intent (or activation without intent) through a separate snapshot taken after
an additional 500 ms settle. Readiness, RPC/resource capture, and CPU measurement
finish before that settle and the snapshot processing. Source elements and
previous/current rectangles are retained. `cls` applies the same five-second
session window and one-second gap rule as boot, excluding `hadRecentInput`
entries. `allShiftSum` includes those entries: route clicks can suppress standard
CLS while still causing a visible shift. Inspect both values and the sources.

For Settings workload measurements, add `--settings-core-schema`. Before the
browser launches, the runner dynamically imports `src/config/schema.ts`, calls
`buildConfigSchemaCore()` once, and supplies its full response as the synthetic
`config.schema` RPC payload. This includes the core JSON Schema, UI hints, version,
generation timestamp, and bundled channel schema metadata. It excludes extra
runtime-installed plugin/provider and channel metadata normally merged by the
Gateway's runtime schema owner. Schema construction is outside sampling; browser
JSON parsing, schema processing, rendering, and the existing response-byte network
shaping remain inside the measured flow. `summary.json` records the flag. Without
it, the existing default fixture is unchanged. This measures a real core schema
payload over the synthetic transport, not a live Gateway or its plugin inventory.

For twenty interleaved base/base/head triplets, supply the base bundle twice and
use 60 runs. The first `candidate` is the A/A control; `candidate-2` is the head.
Run the two profiles serially, with the same built bundles. Set the synthetic
Gateway replay delay as well as the HTTP latency: the remote example uses 100 ms
for both; local uses zero. The default 4 ms frame gap remains in both profiles:

```sh
base_bundle=/absolute/base/control-ui
head_bundle=/absolute/head/control-ui
profiles=(local remote)
for profile in "${profiles[@]}"; do
  network_flags=(--network-latency-ms 0 --download-kbps 0 --latency-ms 0)
  if [[ "$profile" == remote ]]; then
    network_flags=(--network-latency-ms 100 --download-kbps 10000 --latency-ms 100)
  fi
  NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-cold-load.ts \
    --gateway-http --bundle-dir "$base_bundle" \
    --compare-bundle-dir "$base_bundle" --compare-bundle-dir "$head_bundle" --runs 60 \
    --first-load --cold-http-cache --untraced --thread-cpu-time --critical-path \
    --face chat --settings-core-schema \
    --critical-path-route settings --critical-path-route cron \
    "${network_flags[@]}" --output "/absolute/proof/readiness-$profile"
done
```

Use the resulting two `summary.json` paths to summarize readiness, CPU, work
counts, and layout shifts. This keeps each A/A and head comparison paired to the
preceding base sample; percentile values use nearest rank, and median values
average the middle pair. CLS maximums retain isolated shifts:

```sh
node --input-type=module - /absolute/local/summary.json /absolute/remote/summary.json <<'NODE'
import { readFileSync } from 'node:fs';
const stats = (values) => {
  const v = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, median: (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2,
    p95: v[Math.ceil(v.length * .95) - 1], max: v.at(-1) };
};
const metrics = {
  readyMs: (s) => s.elapsedMs,
  taskMs: (s) => s.cpuMilliseconds.TaskDuration,
  scriptMs: (s) => s.cpuMilliseconds.ScriptDuration,
  rpcCount: (s) => s.rpcs.length,
  rpcResponseBytes: (s) => s.rpcs.reduce((sum, r) => sum + r.responseBytes, 0),
  resourceTransferBytes: (s) => s.resources.reduce((sum, r) => sum + r.transferSize, 0),
  cls: (s) => s.presentation.cls,
  allShiftSum: (s) => s.presentation.allShiftSum ?? s.presentation.layoutShifts.reduce((sum, r) => sum + r.value, 0),
};
for (const file of process.argv.slice(2)) {
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  if (summary.results.length !== 60) throw new Error(`Expected 20 complete triplets: ${file}`);
  const report = { file, hostLoadAverage: summary.results.map((r) => r.hostLoadAverage), routes: {} };
  for (const route of ['cold-chat', 'settings', 'cron']) {
    const samples = summary.results.map((r) => {
      const sample = r.criticalPath.find((s) => s.name === route);
      if (!sample) throw new Error(`Missing ${route}: run ${r.run}`);
      return { ...sample, presentation: sample.presentation ?? r.presentation };
    });
    report.routes[route] = {};
    for (const [name, read] of Object.entries(metrics)) {
      const groups = [0, 1, 2].map((slot) => samples.filter((_, i) => i % 3 === slot).map(read));
      const delta = (values) => stats(values.map((value, i) => groups[0][i] > 0 ? 100 * (value / groups[0][i] - 1) : NaN));
      report.routes[route][name] = { base: stats(groups[0]), control: stats(groups[1]), head: stats(groups[2]),
        controlPairedPercent: delta(groups[1]), headPairedPercent: delta(groups[2]) };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
NODE
```

Each route visit saves `run-N.ROUTE.requests.json` with CDP request IDs,
wall-clock timestamps, and observed initiators for that document, including its
settled boot. After all measured runs finish, `run-N.ROUTE.waterfall.html` combines
these records with the existing critical-path capture in a standalone timeline
and table. Open it locally; no server or external assets are needed. Starts and
ends are relative to activation, with carry-in work, a ready marker, and
post-ready work labeled separately. Requests without completed resource timings
remain visible with an unknown end and size.

HTTP sizes distinguish encoded body, decoded body, and transfer bytes; request
sizes are not captured. RPC sizes are UTF-8 JSON frame bytes, excluding WebSocket
framing, headers, and compression. RPC timings include the synthetic replay
scheduler and network shaping, not real Gateway service time. Observed initiator
and caller-stack links do not establish causal completion dependencies. Matching
Resource Timing entries to CDP records uses URL and nearest start time. The HTML
includes no RPC parameters, message contents, or HTTP headers; the existing
critical-path JSON keeps its original shape.

For code-splitting evidence, use a separate `--coverage --untraced` run without
`--cpu-profile` or `--cpu-profile-compare`. Coverage and CPU sampling use different
CDP sessions, while Chromium coverage state is isolate-global. `--thread-cpu-time`
is allowed because it reads Performance metrics without starting the sampler.
Coverage captures observed executed and unobserved raw source bytes; these are
not measurements of data reads, compile cost, or removable code.
`javaScriptResources` separately counts completed JavaScript fetches from Resource
Timing: decoded body bytes, encoded body bytes, and transfer
bytes including headers. Its `outsideCoverage` subset includes fetch-only
preloads, so V8 coverage alone must not be reported as all downloaded code.
Module preloads can parse/compile without evaluation, and dormant function bodies
can be compiled lazily; unused source bytes are not a CPU estimate.

Use a separate traced run (omit `--untraced`) for `trace.compilation`: coarse V8
module parse/compile spans are unioned per renderer thread; this is not an
exhaustive compiler profile. Main-thread and all-renderer
thread CPU are reported separately from wall duration. CPU is unavailable when
the trace lacks complete thread-clock intervals. Never mix traced readiness
timings into the untraced comparison.

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
`firstEnabledComposerMs` retains its original definition: the first matching
hydrated-chat or New Session textarea is visible and enabled. It does not include
the static boot composer or reject read-only or inert editors.

`presentation.firstUsableComposerMs` adds an editable-input observation, with
`firstUsableComposerKind` identifying `static`, `hydrated`, or `new`. It accepts a
visible, enabled, non-read-only textarea with no inert ancestor from the static
boot composer, the active hydrated chat pane, or New Session. It uses the same
animation-frame sampler and visibility check, with no extra geometry or hit test.
This is editor eligibility, not actual key-to-paint latency, compositor paint,
click-occlusion proof, or send admission. Sampling ends at the existing shell and
route completion boundary; the value remains null if no eligible editor was
observed during that window. Older captures have no such fields: preserve them
as absent, without relabeling or retrofitting the legacy metric.

Warm reloads also record `warmReload.milestones.firstLiveTranscript` on the first
sample with both visible transcript rows and the pane's `transcriptReady` state.
It reuses the existing visibility and catch-up observations. `firstTranscript`
still marks the first visible rows, including saved rows, and `catchupApplied`
still marks owner readiness even while the virtualizer keeps rows hidden. The
new marker distinguishes live transcript visibility from both; it is a DOM
readiness observation, not an Element Timing paint. It remains absent if not
observed before collection stops. Cold `firstNonemptyTranscriptMs` is unchanged.

Every run also records browser paint entries (`presentation.firstPaintMs` and
`firstContentfulPaintMs`), the first visible `#openclaw-boot-shell` frame and its
geometry, and the first live shell's geometry. Layout-shift entries retain their
source rectangles and `hadRecentInput` flag. `presentation.cls` uses the largest
five-second session window with less than one second between non-input shifts;
`nonRecentInputShiftSum` retains the total for the measured boot. A zero CLS alone
does not prove matching geometry when DOM nodes are replaced: inspect the static
and live frame/sidebar/composer rectangles and the filmstrip too.

For a first-paint diagnostic, use the same built bundles with `--filmstrip-only`
instead of `--untraced`. This saves `run-N.filmstrip/*.jpg` without the heavy
warm-reload probes. `visual.visuallyCompleteMs` estimates the earliest compositor
frame in the final stable suffix; at 344×236, fewer than 0.4% of pixels may differ
from the final frame by a channel value of at least 32. This excludes small/JPEG
changes and includes skeleton animation, so inspect frames rather than treating
it as a browser-standard paint metric. Traced filmstrip and untraced readiness
samples are separate populations. Compare cold (`--first-load`) and warm (omit
`--first-load`) runs independently, on localhost and with
`--network-latency-ms 100 --download-kbps 10000` for a simulated remote link.
Add `--hold-boot-assets --first-load --runs 1` to a filmstrip diagnostic to hold all
external scripts and stylesheets, capture `boot-assets-held.png` plus completed
resource counts/geometry, then release them and verify ordinary chat readiness.
This deliberately blocked-assets sample is structural HTML-only paint proof,
not a latency sample.
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

Use a separate `--coverage --runs 1 --first-load --cold-http-cache --untraced`
capture to inspect JavaScript exercised by cold boot. Do not combine it with
CPU sampling; the default traced run also starts the CPU sampler. Run a separate
`--cpu-profile` capture for source-mapped CPU attribution. Each `run-N.coverage.json`
records V8 function/block ranges and loaded, executed, and unused UTF-8 bytes per
asset through settlement; nested block counts override enclosing function counts.
Keep coverage captures separate from timing comparisons because instrumentation
changes execution cost. Source maps and the exact saved bundle allow attribution
of the unused ranges; preload transfer budgets remain the performance checker's
authority, including assets that have not executed.

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
(after unloading the app), local storage and session storage. `--gateway-http`
serves synthetic HTTP fixtures natively so production JS/CSS can use the browser's
cache during warm reloads. Without that option, Playwright's synthetic HTTP routes
disable caching: "warm" then describes persisted application state only.
Warm-up captures each build's native local/session storage writes after the
application exits, including page-exit-only cache hints. Measured repeats replay
those frozen inputs without carrying writes from a prior measured run.
Empty reset documents use temporary interception; build switches unload to
`about:blank`. No reset route remains active during a measured navigation, since
Playwright routing disables the browser HTTP cache.
`http.waterfall[].transferBytes` records the actual transfer.

`--warm-reload` adds self-contained cache/paint diagnostics. An optional
`--probe-dir /path/to/probes` supplies `mutattr.init.js`, `loaf-mutation.init.js`,
and `ws-rpc-census.init.js` for additional attribution; `externalRig` records which
extra instruments are available. The output records cache reads, cached transcript visibility,
hello, live catch-up, enabled input, layout shifts, mutation batches, and retained
row elements, duplicate visible row keys, and the same visible row's viewport offset
at the cached-to-live handoff. Visibility and enabled-input milestones are DOM observations;
FCP is the browser's paint metric. Diagnostic runs also save filmstrip frames.
Live catch-up recognizes both `chat.startup` and initial history in a
`sessions.messages.subscribe` reply, so cross-revision runs do not label live rows
as cached rows after the subscription starts carrying history.
The benchmark enables `subscriptionInitialHistory`; requested initial history uses
the shared startup-response fixture owner. Older clients still make a separate
startup request. Scenarios testing that fallback set `subscriptionInitialHistory: false`.
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

For per-row resource counts, the warm runner accepts `--resource-counts` and
`--steps sidebar-resources-scroll-resize,sidebar-resources-idle-visible,sidebar-resources-idle-hidden`.
These scenarios use 1,000 long session labels, 400-message transcripts, and native
clocks. The result records created/active observers, observed targets, callbacks,
intervals, media queries, and global listeners before and after each action.
Run timing comparisons separately without instrumentation, with
`--thread-cpu-time --pairs 20 --compare-bundle-dir <other-build>` and an A/A
control on a loaded host. Hidden idle runs headless: the runner launches full
Chrome for Testing with `--headless=new`, minimizes its own window, and verifies
native document visibility; no window appears on screen. Hidden samples
use a fresh runner-owned profile and Playwright's `noDefaults` connection so its
normal focus emulation cannot override native visibility. The profile and process
are removed after each sample. A browser that
remains visible produces an explicit skip, never a simulated hidden result.

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
The native typing probe appends to the existing draft and verifies that every
dispatched character survives streaming; `streaming.typing` retains the count
and final synthetic draft alongside the timing evidence.

Use `--transcript-messages 2000` for the long-session stream. Add
`--streaming-content tool-code` to grow an open TypeScript fence alongside an
expanded tool card, or `--streaming-panes 2` to stream two independent sessions
in the native split layout. Each pane must retain its typed draft, show the
complete reply, and follow its own growing tail. `streaming.panes` and
`streaming.typingByPane` retain these results; the original first-pane fields
remain available. The default Markdown fixture is still 645 deltas.

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

Use `--streaming-rate 150 --streaming-burst-size 5` to enqueue five snapshots every 33.3 ms (fast-provider bursts). The default rate remains 30 snapshots/s; `--streaming-burst-size 5` alone enqueues five snapshots every 166.7 ms
while retaining the average 30 deltas/s. The mock transport still applies
`--frame-gap-ms`; set it to zero to remove intentional spacing, and inspect
delivery timestamps before treating a group as one-frame delivery.
`--filmstrip-only --streaming-reply` retains the stream's screenshot frames in
`run-N.streaming.filmstrip/`. Traced/filmstrip runs also check plain-paragraph
suffix visibility on the next rendering frame (`streaming.textVisibility`);
keep these instrumented captures separate from timing comparisons.
Streaming reports count synchronous
stream assignments, frame publications, pane render calls/time, forced rail
observations, and row ResizeObserver deliveries. These are separate boundaries:
publication is not a rendered commit, and pane render time excludes subsequent
Solid and Markdown work. The source-mapped CPU profile covers that later work;
the task/microtask and next-rAF timings do not measure presentation to the screen.
After timing, each run also checks that the real transcript grew and remains
within two pixels of its native scroll bottom, without manually requesting a render.

For a mixed fast turn in both engines, use the cross-engine companion:

```bash
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --bundle-dir dist/control-ui --steps streaming-mixed-fast \
  --viewport desktop --engines chromium,webkit --pairs 1 \
  --output .artifacts/streaming-profile
```

This workload delivers the 645-delta Markdown reply at 150 deltas/s in bursts
of five, with reasoning, 24 tool calls and results, and an image arriving midway.
It requires `--viewport desktop`: mobile's modal navigation drawer prevents
simultaneous composer and sidebar input.
It checks native composer typing, the sidebar's Show more action, complete text,
tool results, reasoning, tail following, and image decoding. The outer action
includes the final image inspection; streaming probe metrics stop before that
inspection. Delivery-to-next-task includes scheduling delay. Delivery-to-rAF and
DOM-mutation-to-rAF are frame-boundary proxies, not paint timestamps.

Use a separate `--trace` run for script/layout/style attribution. Long Task API
metrics are present only when supported; WebKit's missing counters are not zero.
WebKit Inspector durations are elapsed time, not CPU consumed by the action.
The probe emits `streaming-reply:start:<startedAt>` once per stream run to align
Inspector records with the snapshot's page-clock `startedAt` and relative delta
timestamps. `startMarkCompletedAt` bounds the mark call's completion; use the
interval between it and `startedAt` as clock uncertainty when Inspector records
the mark's emission time. Delivery-window script/style/layout durations may
overlap and include other tasks between deltas; they are elapsed work within the
window, not CPU time or causal attribution to a single delta. Pool deliveries
with identical timestamps and end the last window at `startedAt + elapsedMs`.
`--cpu-throttle 4 --engines chromium` measures Chromium's emulated slowdown;
WebKit has no equivalent supported CPU throttle, so requesting it fails explicitly.
Use `--compare-bundle-dir` and `--control-bundle-dir` for interleaved candidate and
A/A comparisons, following the same-machine timing rules above.

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

### Initial completed and active transcript

Use `scripts/bench-control-ui-rich-boot.ts` to isolate first-screen transcript
content from the larger inventory workload. It serves production bundles through
the Gateway HTTP owner with synthetic RPC, starts with one completed tool run and
one active answer, and records the first visible composer, completed answer, and
active answer. It interleaves base, an identical base control, and head with cold
HTTP caches, renderer thread CPU, host load, screenshots, and resource timing.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-rich-boot.ts \
  --bundle-dir /path/to/base --compare-bundle-dir /path/to/head \
  --pairs 20 --network-latency-ms 100 --output .artifacts/rich-boot-rtt
```

Omit network latency for localhost; a positive latency also applies 10 Mbps
throughput. These results cover browser rendering, not provider latency.

The rich-boot report also records Resource Timing phases, negotiated protocol,
compression/cache response headers, and the Gateway's actual request inventory.
Use those phases to distinguish connection queueing from response transfer.
Add `--service-worker` to install the production worker, leave the warm document,
stop the worker, and clear HTTP, asset, and browser-state caches before each
measured navigation. Worker fetches receive the same network profile as page
fetches. The report includes preload state and worker requests; each sample must
issue exactly one document request. This mode measures a stopped worker with
cold assets, rather than an already-open tab or an offline-cache hit.
