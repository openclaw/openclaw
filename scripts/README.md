---
summary: "Repository script entry points and compatibility notes"
read_when:
  - Looking for an existing script before adding a new one
  - Running repository checks, tests, docs, Docker, release, or GitHub helper scripts
  - Updating package scripts or CI workflow script references
title: "Scripts Directory"
---

# Scripts Directory

The `scripts/` directory contains repository tooling used by local development,
CI, docs publishing, releases, Docker proof, and maintainer operations. Prefer
the package-script entry points in `package.json` when one exists, then read the
underlying script before running it directly.

## Compatibility

Many scripts are stable paths referenced by `package.json`, GitHub Actions,
docs, and maintainer runbooks. Do not move, rename, or regroup scripts only to
improve taxonomy. A directory migration needs an explicit maintainer-approved
compatibility plan for package scripts, workflows, docs snippets, and any raw
script paths users may have copied.

This index is a discovery aid for the current flat layout. It does not define a
new directory taxonomy.

## Common Entry Points

| Area            | Prefer                                                                         | Notes                                                                                                               |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Build           | `pnpm build`                                                                   | Runs `scripts/build-all.mts`; use specific build scripts only when debugging a build stage.                         |
| Changed checks  | `pnpm changed:lanes --json`, `pnpm check:changed`                              | Lane classification lives in `scripts/changed-lanes.mjs`; changed-file checks live in `scripts/check-changed.mjs`.  |
| Docs            | `pnpm docs:list`, `pnpm docs:check-mdx`, `pnpm docs:check-links`               | Backed by `scripts/docs-list.js`, `scripts/check-docs-mdx.mjs`, and `scripts/docs-link-audit.mjs`.                  |
| Formatting docs | `pnpm format:docs:check`                                                       | Uses `scripts/format-docs.mts`; use write mode only when intentionally formatting docs.                             |
| Lint            | `pnpm lint`, `pnpm lint:core`, `pnpm lint:all`                                 | Wrapper scripts keep oxlint behavior aligned with repo config.                                                      |
| Targeted tests  | `pnpm test <path-or-filter>` or `node scripts/run-vitest.mjs <path-or-filter>` | Avoid bare `vitest`; it can start watch mode.                                                                       |
| Changed tests   | `pnpm test:changed`                                                            | Uses the repo's changed-test resolver instead of a broad Vitest run.                                                |
| Docker proof    | `pnpm test:docker:all`, `pnpm test:docker:rerun`, `pnpm test:docker:timings`   | Use the planner/rerun helpers before launching broad Docker work.                                                   |
| Live proof      | `pnpm test:live`                                                               | Live checks require the matching environment and credentials.                                                       |
| Release checks  | `pnpm release:check`, `pnpm release:beta`, `pnpm release:candidate`            | Release scripts are maintainer workflows; read release docs before use.                                             |
| GitHub reads    | `scripts/gh-read`                                                              | Uses a GitHub App read token when configured, leaving normal `gh` login for writes.                                 |
| Commits         | `git add <files...>` then `git commit -m "<message>"`                          | Stage only the intended files for each commit.                                                                      |
| Remote proof    | `node scripts/crabbox-wrapper.mjs ...`                                         | Use when the current host lacks the required isolation, OS, device, or capacity; sync each run and reuse the lease. |

## Runtime script generation and proof builds

`pnpm runtime:scripts:gen` bundles embedded programs and their materializer.
Whitespace minification removes esbuild's source-path comments, so generated
bytes stay identical when dependencies move between pnpm virtual stores.
`pnpm runtime:scripts:check` still requires an exact byte match; source-run build
stamps still hash the complete generated files.

Use `pnpm build qaRuntime` for reusable runtime test artifacts. Controllers that
also verify `dist/build-info.json` against a source commit should use
`pnpm build sourcePerformance`, which adds that identity metadata without a UI
or declaration build. Keep generated files unchanged after either build so
equivalent-input admission can certify the same source bytes.

## Exact memory search benchmark

Use `scripts/bench-memory-search.mjs` against a disposable PostgreSQL database
with pgvector, pg_trgm, and unaccent installed. Set `PGMEMSEARCH_CONNECTION`,
`PGMEMSEARCH_OUT` (a new directory), and `PGMEMSEARCH_CHUNKS` to 20000 or 50000;
run it through `node --import ./scripts/tsx.mjs`. The deterministic corpus needs
no embedding provider. `--help` lists all inputs.

The benchmark interleaves 100 baseline/candidate pairs after five warmups for
vector, keyword, and hybrid retrieval. It captures every search statement,
EXPLAIN ANALYZE/BUFFERS, exact result hashes, p50/p95, and five paired blocks.
The candidate orders by the selected distance; the baseline repeats the bound
cosine expression. `PGMEMSEARCH_SOURCE_MODE` identifies which SQL shape the
checkout produces, so that arm executes unchanged. Eligibility, ranking, and
limits stay fixed. Compare the block deltas and spread at both corpus sizes;
unchanged hashes and statement counts are required before accepting a speedup.

Run `scripts/bench-memory-search-sqlite.mjs` with a separate fresh output
directory and the same chunk count for the production sqlite-vec KNN control.
Both benchmarks create synthetic state; stop and remove only their disposable
database state after collecting results.

## Control UI Talk

`scripts/bench-control-ui-talk.ts` compares frozen production UI bundles with a
synthetic microphone and provider. The default transport is `webrtc`; use
`--transport gateway-relay` to exercise native PCM capture and playback:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-talk.ts \
  --transport gateway-relay \
  --bundle-dir <baseline> --compare-bundle-dir <candidate> \
  --states listening,speaking,responding,idle,hidden \
  --viewport both --cpu-throttle 1,4 --pairs 10 --aa --duration-ms 5000 \
  --output .artifacts/control-ui-talk-pcm
```

PCM mode requires an explicit supported state list: the default includes the
WebRTC-only `transcribing` state. PCM `responding` means native output playback
while the UI remains listening, rather than the WebRTC thinking animation.
PCM mode rejects `--startup-latency`, `--startup-warm-cache`,
`--compare-suspend-native-audio`, and transcript states. `--aa` adds same-baseline
control pairs; alternate pair order reduces first/second browser bias.

Ordinary comparisons use main-thread CPU counters with native clocks and
service-worker precache/network quiet before each measurement. `--trace`,
`--counters`, `--frames`, and `--process-wakeups` collect separate diagnostics;
`--frames` adds its own animation loop and cannot measure idle or hidden states.
PCM observations retain native input-callback/append timing, output scheduling
and completion, and UI status/level endpoints. After Stop, the probe requires
closed contexts, ended tracks, and stable callback/append/playback counts.
Before PCM responding starts, the probe waits for silent input to reach level
zero. Cancellation retires matching synthetic output and records its reason;
an applied cancellation during measurement fails the observation. Failure
artifacts include document visibility, native window bounds, audio context
states, and the captured PCM activity.

Use identical harness sources and flags for both sides. The synthetic PCM
provider and native observers add measurement overhead. Callback-to-append and
event-to-schedule timings are browser-local; they do not measure hardware,
acoustic, real-provider, or network latency. Cadence bounds prove sustained
delivery, not a latency acceptance threshold. Reports retain source and bundle
hashes, failed samples, and per-cell results.

## Control UI warm interactions

### Real-Gateway Usage model filters

`bench-usage-gateway.ts` measures the production Usage page against isolated
Gateways with durable synthetic session transcripts. Build both clean source
checkouts with `pnpm build sourcePerformance` first, and supply a frozen
production UI build with `--ui`. By default all three roles use that build.
For a renderer change, add `--head-ui <frozen-candidate-ui-build>`: the candidate
uses that build while both baseline controls keep `--ui`. Each role's complete
UI tree hash is recorded in `helper-sources.json` and checked again after cleanup.
Gateway and UI build identities are separate; do not attribute a new renderer to
a backend-only build. The driver verifies each source commit against build-info
and both local build stamps, then hashes the complete runtime output and generated
workspace package outputs before and after the experiment. A frozen source build
needs both `dist/` and the package `dist/` roots listed by
`scripts/lib/tsdown-output-roots.mts`. It does not build, install, contact a provider, or use an
operator's Gateway state.

The source helper only seeds durable synthetic state and exits after draining
its writers. Ordinary warm runs (including smoke and complete-sequence runs)
then prepare each compiled Gateway through full-range Usage requests, retrying
only after successful Usage publications until the response is complete and its
counts match the fixture. Run with `TZ=UTC` so preparation uses the same
specific-UTC request shape as the browser's Local mode. `warm-preparations.json` records this setup separately
from measured observations. Its deadline is the Gateway's existing managed
lifetime; the measured response deadline remains 60 seconds. Cold modes leave
this preparation disabled, preserving their initial-load measurements.
The measured Gateway runs that checkout's normal `dist/entry.js`, with production
worker entrypoints. Seeding and startup are separate from browser default
readiness, full-range loading, and warm filters. Numeric dispatch counters
observe native worker messages, including the first synchronous task, without
retaining or rewriting their payloads.
Synthetic state uses the system temp directory so secure temporary-state discovery
keeps its normal protection; `--out` owns the retained proof artifacts separately.
The driver fixes one UTC end date for every fixture, including runs crossing midnight.
All roles use the invoking driver's seed, RTT, and dispatch-observer helpers,
whose hashes are recorded separately from the per-checkout runtime. The seed
helper must remain compatible with both checkouts' database schemas. No
aggregation runs in the shared seed process. Each Gateway uses its own runtime
profiling and graceful-stop preloads.

Start with the three-session smoke, which includes mixed-model usage and saved
context, before increasing volume:

```sh
TZ=UTC NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-usage-gateway.ts \
  --base <baseline-checkout> --head <candidate-checkout> --ui <frozen-ui-build> \
  --out <new-output-directory> --sessions 3 --smoke
```

The smoke checks both model filters with one baseline/candidate/baseline triplet
at Chromium 4× and at localhost and 100 ms added RTT. The candidate must dispatch
one prepared-cohort task per model query, without preparing or resending raw
rows. Totals and visible session counts must match independent fixture values.
This is specifically a qualification workload for the prepared-cohort path;
an older candidate without that path is expected to fail the work-count assertion.

For qualification, use `--sessions 12000 --pairs 20` without `--smoke`. It seeds
180 days and 96 models, retaining the same population throughout. Each distinct
model query receives 20 interleaved triplets in each 1×/4× and localhost/100 ms
cell. Keep the two queries separate when computing medians, p95 and min–max;
baseline/baseline results are the same-host control. Record host load and judge
noisy wall times with CPU and work counts. A clean median regression is at most
5% with no worse p95; any 20% regression requires investigation.

Use `--warm-cpu 1` or `--warm-cpu 4` to select one CPU rate for an ordinary warm
run. Both models and RTT settings remain measured; for example, `--pairs 10
--warm-cpu 1` records 120 filter observations plus 12 setup observations. The
selector is also available with `--diagnostic` and `--structure` to attribute the
same CPU rate; it is rejected with smoke or cold modes. Attribution still defaults
to native CPU when the selector is omitted.

Use `--engine webkit` for the same real-Gateway model queries, independent fixture
assertions, alternating baseline/candidate/baseline triplets, and both RTT profiles
in headless WebKit. WebKit runs at **native CPU only**; `--warm-cpu 4` is rejected
because Playwright WebKit has no equivalent throttling control. It cannot certify
a WebKit 4× target. Untraced browser CPU/heap/process counters are null, not zero;
Gateway CPU and worker counts remain available. `--diagnostic --engine webkit`
uses the existing in-process Inspector transport for separate Timeline and
ScriptProfiler attribution. These durations are elapsed wall time, not CPU, and
the trace includes automation and metric-probe boundaries. CPUProfiler's smoothed
utilization is not action CPU. CDP-only `--structure` and `--warm-sequence` remain
Chromium-only.

Add `--profile-last-pair` to an ordinary warm run to append one traced pair
covering both models after all requested untraced pairs. It reuses the same
prepared Gateways, browsers, CPU rate and RTT, and produces the same attribution
files as `--diagnostic`, plus mutation counts and before/after local node
identities without copying DOM content or forcing GC. The mutation observer runs
only during the appended diagnostics. Appended rows have `diagnostic: true`;
exclude them from timing summaries. This option cannot be combined with smoke, cold, diagnostic,
structure or warm-sequence modes.

Add `--screenshots` to capture each role's first model pair after action timing,
resource probes, and any trace shutdown. These synthetic full-page PNGs identify
the role, engine, CPU rate, RTT, and model in their names. Inspect them before
publishing. Screenshot work is outside the recorded action interval.
After the full localhost sequence, it also captures the overview, cost-window, and session
panels, then the session panel at a 390 px viewport. These lower-panel captures
do not change the viewport or scroll position during any timed action.

Outputs include actual RPC latency/bytes, Gateway process and main-thread CPU,
Chromium thread-tick task/script/layout/style CPU for non-navigation actions,
whole-renderer process CPU,
sampled renderer RSS and JS heap endpoints, worker dispatch counts and packed
bytes, resource snapshots, and cleanup failures. Each role owns a separate
headless browser so process metrics exclude the other roles; record host memory
as well as load with this three-browser setup. Process probes retain their own
start/end timestamps and bracket the action outside its wall/main-thread timing;
whole-process CPU includes that boundary overhead. Missing metrics or renderer
PID changes fail collection. Default navigation records document CPU as unavailable:
those counters reset across navigation, so only the whole-renderer and Gateway
CPU intervals cover cold readiness. Heap and RSS endpoints are neither retained-memory
nor peak/GPU measurements; no browser GC runs inside these timed cells. Child
output streams
redact each generated fixture token before writing setup or shutdown logs.
Chromium throttling does
not throttle the Node Gateway. The TCP relay adds 50 ms in each direction without
interpreting HTTP or WebSocket messages; scheduling delay and backpressure may
add more, and TCP handshakes are undelayed. Localhost bypasses the relay.
Automation-to-visible-assertion wall time is not INP. Population activation is
recorded separately from warm filters; per-cell memory snapshots do not establish
bounded multi-snapshot retention. Runs without `--head-ui` cannot demonstrate a
renderer change because all roles share the same UI. Keep failed output for diagnosis.

For a fresh compiled cold comparison, add `--cold`. One invocation starts one
fresh baseline/candidate/baseline triple, using separately seeded durable state,
and measures only default readiness followed by the first 180-day population
request at native Chromium CPU and localhost. It produces six observations and
skips model filters. Run a screening triple first; repeated qualification needs
separate invocations with new output directories, not `--pairs`. Twenty such
triples provide 20 observations per role and phase. Keep A and C separate when
reporting the cold baseline controls. Neither this native/localhost comparison
nor reused later cells establish cold 4× or 100 ms RTT performance.

For the backend's first full-range read, add `--cold-backend`. It starts fresh
baseline/candidate/baseline Gateways one at a time and makes each one's first `sessions.usage`
RPC request all 180 days through the canonical Usage request helper. No browser
or default 30-day request warms this path. The three observations retain actual
request parameters, every response payload including partials, Gateway process/main-thread and
worker CPU snapshots, aggregation dispatches, and post-request resources. First-response
and complete-ready wall/CPU metrics are separate. If Usage is still being summarized,
successful `chat.metadata.changed` publications trigger coalesced re-reads, matching
the page's session refresh path; no timed session polling occurs. All reads and
publication waits share the same 60-second deadline from the first request. Startup
backfill stays enabled, and each Gateway fully drains before the next role starts.
Startup readiness diagnostics are saved even when the readiness check fails. A
deadline abort remains a failed, censored observation without complete-ready metrics;
the runner drains that Gateway and continues the remaining roles and pairs. Any
failed observation makes the invocation exit nonzero; other errors stop the run. The
client must run with `TZ=UTC`; it asserts the resolved timezone and offset before
starting Gateways. The canonical helper then emits the browser fixture's exact
date parameters (`mode: "specific"`, `timeZone: "UTC"`, `utcOffset: "UTC+0"`),
with family grouping and the usual overview/cost-descending defaults.
Each client has a fresh in-memory device identity and no saved credential writes.
The resource capture forces main-isolate GC after timing; worker heaps are cached
samples with their original coverage and age, not forced-GC retained memory.
This single triple screens cold backend behavior. It does not qualify browser
readiness or establish repeated cold performance.

For repeated fresh-process backend reads, use `--cold-backend --cold-pairs 20`.
Each role seeds once and snapshots its synthetic state after its seed writers
exit, before any compiled Gateway opens it. Each Gateway process tree stops before
the next role starts, and snapshots are restored at the same absolute path; each role
keeps its port and token. File bytes and symlink targets are checked after each
restore. Every sample starts a fresh compiled process with the pristine report
state, and output files retain the pair number. This does not flush the operating
system's file cache or measure cold-storage I/O. Omitting `--cold-pairs` keeps the
single-triple behavior; `--pairs` still controls only warm filter repetitions.

For attribution, add `--diagnostic`. It runs only 1× at localhost and 100 ms RTT,
prepares the normal page, runs an untraced model00/model01 pair, then traces
model00 from model01. The six traced actions retain full synthetic Usage response
payloads, raw trace events, a 1 ms sampling profile, mapped main-thread hotspots,
and events from every renderer thread in the wider process-probe interval.
Marks distinguish action, response observed by the page, visible readiness,
the two animation frames, and process-probe bounds. Paint, raster, compositor
and GC events remain in the raw artifacts; overlapping trace slice durations
must not be summed as CPU. These traced actions are diagnostic evidence, never
samples for the untraced timing acceptance table. The narrow modes are mutually
exclusive with `--smoke` and each other.

For warm renderer attribution, `--structure` runs at 1×/localhost by default.
Use `--structure --structure-rtt 100` for the same diagnostic with 100 ms added
RTT; the selector is valid only with `--structure` and accepts `0` or `100`. Each role
warms model00/model01, traces a natural return to model00, resets to model01,
then traces a separate model00 return after browser GC. Only that second return
has forced-GC heap and DOM counters before and after; GC stays outside timing.
The six traces retain passive mutation-record counts and local chart/row node
identities, plus all WebSocket frame IDs, methods/events, byte counts, and times.
They retain no frame payloads or DOM text/attribute values. Added/removed counts
refer to mutation-record roots, not every descendant. The observer and profiler
add work, so these runs diagnose extra rendering or garbage collection; they
never replace the earlier untraced timing results or establish a performance win.
After population timing, this mode also checks the document's build identity and
fetches the same-origin JavaScript and CSS assets observed by the browser. It
compares their bytes with the selected frozen UI tree and writes one
`served-ui-<role>-<cpu>x-<rtt>ms.json` receipt per role. This verifies the served
build; it is not timing evidence, and ordinary warm runs do not make these requests.

The headless Chromium/WebKit companion reuses the current interaction catalog and
adds cold boot, persisted-state warm reload, 2,000-message open and 645-delta
streaming. It alternates engines and bundles within each pair:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --bundle-dir dist/control-ui --pairs 10 --viewport both
```

Use `--steps chat-typing,session-switch` for focused comparisons and `--trace`
for separate Playwright/Inspector attribution runs. `--compare-bundle-dir` and
`--control-bundle-dir` add candidate and A/A control builds. Repeat the control
option for interleaved base/head/base/head observations. For Workboard, repeat
`--control-source-root` in the same order as the control bundles. Reports retain the
metric time domain: WebKit Inspector durations are wall time, while Chromium
CDP uses thread CPU. Untraced WebKit runs leave those counters null. `--cpu-only`
collects WebKit's sampled process utilization without Timeline or ScriptProfiler;
its estimate requires at least one second of interior sample coverage. The explicit
`provider-model-picker-cycles`, `session-switch-cycles`, `sidebar-toggle-cycles`,
and `cron-held-typing-cycles` steps repeat eight fixed actions for longer CPU
intervals, retaining their selection, focus, and held-request contracts. Use
separate untraced runs for timing. Compare automation wall time
across engines; do not divide their script or CPU measurements as though they
were the same metric. Mock routing
disables HTTP caching; warm reload measures persisted state in the same context.
Boot observations include browser-local transcript/composer readiness, navigation
and optional paint milestones, completed-by-ready JavaScript/CSS/font requests,
and connect/history RPC timings. Resource totals exclude requests still in flight
at readiness; unavailable byte or paint values are omitted. Font loading status
is sampled when evidence is collected, not at the earlier readiness milestone.
The synthetic RPC timings include browser scheduling and fixture delivery; they
do not measure a real Gateway's network latency.
Mobile transcript-top uses a native scrollport jump because Playwright's mobile
WebKit driver has no wheel input; it is not a wheel-latency measurement. Tracing
omits DOM snapshots so snapshot traversal does not dominate attribution.

Streaming coverage is selectable with `--steps streaming-645-deltas`,
`streaming-645-deltas-slow`, `streaming-large-transcript`, `streaming-two-panes`,
and `streaming-tool-code`. The slow case delivers the same 645 snapshots at
15 Hz instead of 30 Hz; this throttles delivery, not CPU (WebKit has no matching
Chromium CPU-throttling API). Every pane must retain native typing, render the
complete reply, and follow its growing tail; the tool/code case keeps its tool
output expanded. `large-transcript-fast-scroll` traverses 2,000 messages over
120 animation frames and reports frame gaps, estimated dropped frames, mounted
rows, and viewport-center blank samples. These are DOM geometry samples, not a
paint filmstrip. `large-transcript-return-bottom` measures the native Scroll to
latest action separately. WebKit lacks long-animation-frame entries; unsupported
counters are reported explicitly rather than interpreted as zero work.

Style/layout census can select the existing `settings-open`, `settings-sections`,
and `data-*` actions together with `theme-switch-cycles` and
`sidebar-live-style-cycles`. The latter exercise real preference and session
lifecycle publications. `workboard-style-cycles` loads the native plugin and its
1,000-card fixture, preserving its virtual window; use `--source-root`, `--compare-source-root`, and
`--control-source-root` to bind its plugin assets to the corresponding bundle's
source checkout. The manifest records each plugin tree and asset hash.

Use `--steps memory --viewport desktop --pairs 1` for the opt-in cross-engine
retention census, or select individual `memory-route-usage`,
`memory-long-session`, `memory-workboard-updates`, and
`memory-mcp-relay-updates` steps. Route scenes make 20 same-document visits;
the long-session scene switches among ten 2,000-message sessions and streams
three replies; plugin scenes retire five mounts after 50 verified updates each.
`memory-workboard-idle-control` and `memory-workboard-mounts-control` prime the
same 50-update warmup, then capture four rounds without updates (idle or repeated
mount/retirement). Compare these with the update workload to distinguish
Inspector/allocator footprint from surviving application data.
Each checkpoint drains intentional retirement timers, clears synthetic request
history, requests two GCs and saves a heap snapshot. Each observation gets its
own browser process. Reports include process-tree RSS, WebKit resource categories,
heap class counts, detached DOM and active resource counters.

Memory captures are excluded from the latency table. Compare warm and later
checkpoints within each engine before attributing growth: Inspector/JIT warmup,
retained Chat panes and bounded caches are not leaks. WebKit snapshot self sizes
omit some backing stores, and its DOM counts cover JavaScript wrappers;
Chromium supplies native DOM counters and snapshot detachedness. RSS can retain
allocator capacity after GC and excludes platform services reparented outside
the owned browser process tree. Native Workboard/MCP fixtures build from the
current checkout; bundle comparisons alone do not compare plugin revisions.
The collector clears WebKit Inspector's retained snapshot history after every
capture, so WebKit heap object IDs are checkpoint-local. Raw snapshots remain
available for class/edge inspection; use Chromium for stable cross-snapshot IDs.

### Synthetic Gateway interactions

Build with `pnpm ui:build`, then collect the production renderer's desktop and
mobile interactions against the synthetic Gateway:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts --trace
```

The report links each asserted step to its screenshot, explicit-mark trace,
source-mapped CPU profile, and interval RPC counts. It covers 1,000 sessions,
two 400-message transcripts, 1,000 models, and 500 Cron jobs. Sessions retains
its supported pagination; text search uses the command palette, not the sidebar.
Navigation setup is outside the measured interval. Native clocks and animations
remain enabled; profiling overhead is included and no live provider is called.
Cron search pastes one complete query so both builds perform the same Gateway
request; model and session searches use sequential key input. The separate
`cron-search-typing` scenario exposes burst-input request coalescing; compare its
request counts before interpreting latency differences as equal work.

Compare saved production builds serially with at least ten interleaved pairs:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts \
  --bundle-dir <baseline> --compare-bundle-dir <candidate> --pairs 10 \
  --steps model-picker-open-search
```

Use `--viewport desktop` or `mobile` to narrow a diagnosis. Comparisons omit
profiling and report median, p95, and min–max; every cell over 20% worse is marked
for review. These are report-only measurements, not timing gates. Wall time is
automation-to-assertion time, not INP. Keep failed attempts alongside successful
captures and compare only runs with the same fixture, viewport, and collection mode.

Heavy-content steps use `heavy-<fixture>-<action>` IDs. Fixtures are `code`
(5,000 TypeScript lines), `auto-code` (5,000 language-free lines), `diff`
(5,000 changed lines across ten files), `oversized-code` (the existing Markdown
parse-limit fallback), `table` (300 rows × 12 columns), `tool-diff` (5,000 native
input patch rows, existing 400-line preview cap), `tool-diff-error` (the same
patch rejected with a complete error message and Raw selected initially),
`terminal` (5,000 short output lines), `terminal-dense` (5,000 distinct lines,
220,000 characters), `json` (5,000 values, above the JSON formatter cap),
`json-format` (1,900 values, within that cap), `json-nested-dense` (800 nested
records with multiline stdout, 214,083 characters), `images` (40 repeated tiny
inline PNGs), and
`large-images` (40 distinct 1,024 × 1,024 native PNG attachments, about 4 MB
encoded). The large-image arrival waits for all 40 images to load with their
intrinsic dimensions; this does not force offscreen bitmap decoding. Native cards publish
with the final message, while inline Markdown images also stream.
Actions include `arrival`, `stream` (20 frame-separated
updates), `expand`, `collapse`, `scroll`, `copy`, `output-open`, and JSON
`raw-toggle` where those controls exist. These scenarios use an empty transcript
to isolate content cost. Copy uses an instrumented clipboard boundary and checks
the exact copied string; it does not measure operating-system clipboard latency.
Dense tool expansion checks the existing exact 8,000-character preview; full
output checks the real `chat.message.get` loader's 2,000,000-character read cap,
complete display, and original response bytes. `output-scroll` traverses every
viewport band of the complete dense sidebar output and verifies its bottom.
`heavy-input-{card,sidebar}-{closed,first-open,reopen}` covers a 5,000-line,
150,000-character Tool Input and records hidden DOM ownership while preserving
its full source. `heavy-input-nested-{small,large}` compares 25 and 5,000 nested
rows with the same exact 400-character argument preview.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts \
  --bundle-dir <baseline> --compare-bundle-dir <candidate> --pairs 10 \
  --viewport desktop --thread-cpu-time --first-pair-screenshots \
  --steps heavy-tool-diff-expand,heavy-tool-diff-error-expand,heavy-json-format-output-open,heavy-json-format-raw-toggle
```

Record a baseline/baseline control on a loaded host. Compare renderer CPU,
long-task maximum, DOM/highlight counts, and heap-byte deltas alongside wall
latency; heap deltas are transient allocation measurements, not retained-heap
proof. The heavy-content targets are no arrival task above 100 ms and no scroll
task above 50 ms. Review every median/p95 cell; a clean median regression is at
most 5% with no worse p95 (or another ten pairs confirming the band). Any 20%
regression blocks; a missed target does not invalidate a measured improvement.
Run `--trace` separately for attribution, never mix traced and untraced timings.
For deferred highlighting, `raw-arrival`/`raw-stream` stop when every source
character is readable; ordinary `arrival`/`stream` also wait for the seven-line
syntax preview. `full-arrival`/`full-stream` expand immediately and wait for all
5,000 TypeScript keywords or 5,030 diff spans. `expand` and `scroll` also wait for
complete syntax before ending or starting their respective interval. The
`unsupported-code` SQL-comment fixture checks the plaintext path, and
`heavy-code-sequential` finishes three distinct blocks in succession. A
benchmark-only Worker wrapper records highlighter starts, replies, errors,
termination and live count; no-op completion uses these events rather than an
assumed delay.

`heavy-table-copy` verifies independent expected TSV; code/diff and tool copy
steps verify every original text character. Native scrolling uses overlapping
viewport bands and verifies the actual bottom. Large-image evidence reports
binary PNG bytes separately from encoded data-URL characters.
`heavy-managed-image-copy` drives Copy image with distinct thumbnail/original
assets, then verifies the original PNG bytes and dimensions in a native
`ClipboardItem` intercepted at the page-local clipboard boundary. Its separate
`copyReadyMs` is one exploratory action-to-blob interval; the OS clipboard is
untouched. `heavy-code-retirement-gc` is a separate
diagnostic: replace and clear one canonical message ten times, require zero live
workers after each clear, and explicitly collect garbage before each heap
snapshot. Its first two rounds warm both alternating sources; report the later
heap points and renderer RSS endpoints, not its forced-GC CPU or latency. Each
replacement arrives through a committed-message event and the real history
refresh path, with the synthetic Gateway supplying the next canonical snapshot.

Use `--counterbalance` to alternate AB and BA order across pairs.
`--asset-latency-ms 100` adds the same 100 ms response delay to both bundles'
HTTP asset requests, including dedicated-worker module imports. It simulates
asset RTT without bandwidth shaping or Gateway/provider latency. Compare this
with a separate zero-delay run. `--renderer-process-metrics` records CDP CPU for
the owned renderer processes (including dedicated-worker threads) and `ps` RSS
before/after the interval. Those RSS endpoints include renderer allocations and
decoded image memory, but do not prove retained-heap bounds or GPU memory.
Process churn invalidates that sample's process metric instead of treating a
missing process as free work. Main-thread script/task CPU and JS heap snapshots
remain separate metrics; a worker shift is not a total-CPU reduction by itself.

If the owned Chromium process crashes in the macOS display/compositor path,
use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to select the installed matching
Playwright headless shell for both arms. The manifest records the executable;
compare only against the same browser configuration.

## Control UI route dependency probes

`bench-control-ui-route-leaks.ts` compares cold direct navigation using separate
coverage and interleaved timing contexts. The optional `apps-catalog`,
`apps-open-immediate`, and `apps-open-idle` routes seed a synthetic catalog and
open its first App through the real launch, view, and sandbox path. Immediate
opens have no intentional wait; idle opens wait at least two seconds without
manual preloading. Each starts in a fresh context without visiting Chat first.

Use `--routes apps-catalog,apps-open-immediate,apps-open-idle,memory` to include
the shared-code control. The report retains cold and first-open measurements
separately, plus combined elapsed time, JS/CSS transfer phases, and native counter
and close checks after the action cutoff. Combined elapsed does not waive a
first-open regression. Phase timestamps require an aligned document/CDP clock;
coverage timings are diagnostic. Main-target CPU and V8 omit inner-App and worker
execution. The 100 ms HTTP profile does not delay the synthetic WebSocket.

Browser/Reader probes are opt-in: `browser-focus-existing`,
`browser-session-mobile-first-open`, `browser-session-mobile-dark-first-open`,
and `reader-activity-first-open`. These use native navigation/panel controls and
retain separate cold and first-open phases, raw clock evidence, no-write checks,
and post-close settlement. They cannot be combined with `--interactions`.
Completed contexts append once to `samples.jsonl`; `summary.json` is written
after browser/server cleanup, including when a later context fails.

## Control UI request waterfalls

The production-bundle cold-load harness can record usable-screen readiness,
Gateway request/reply times, exact duplicate method/parameter sets, overlapping
identical requests, resource timing, and renderer CPU counters. It reuses the
team-scale synthetic Gateway; these are renderer/mock measurements, not real
Gateway server timings.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-cold-load.ts \
  --bundle-dir <built-control-ui> --first-load --runs 1 --face chat --untraced \
  --critical-path --session-switch --thread-cpu-time --latency-ms 0 --frame-gap-ms 0 \
  --output <proof-dir>
```

Use `--boot-route new` without `--session-switch` for New Session. The default
first-navigation order is Sessions, Settings (Appearance), Cron, Agents. Repeat
`--critical-path-route <name>` to select an order or isolate a single destination.
The harness reloads and settles the boot document before each destination, so
earlier pages cannot warm a later page's domain owner. With `--first-load`, it
first unloads to `about:blank`, clears all measured-origin storage and the browser
HTTP cache over its existing CDP session, and clears session storage on an empty
same-origin preparation document. That document seeds only the existing mock's
build identity; no application code runs there. These resets also run before
each sample. Cold here means fresh application owners, persistent application
storage, and HTTP cache; the Chromium process, V8 code caches, and OS caches remain
warm. Navigation starts after authoritative boot RPCs settle. The harness uses
existing navigation links and the Settings keyboard shortcut; opening the Pages
catalog is preparation outside the measured navigation interval. Each record has
its own document time origin.

For ten serial interleaved cold pairs in one process, add
`--compare-bundle-dir <candidate-control-ui> --runs 20`. Two or three bundle slots
are supported and every cycle must be complete. Use a second independent copy of
the baseline bundle as the comparison for an A/A control. The synthetic server,
fixture, and init scripts are shared; each measured document's owners and storage
are reset. `--gateway-url` remains restricted to one first-load sample without
bundle comparison, so real server-cache lifecycle remains externally controlled.
`--warm-reload` cannot be combined with `--first-load`; the existing persisted
warm-snapshot comparison path remains separate.

For the 100 ms RTT / 10 Mbps profile, replace `--latency-ms 0` with
`--latency-ms 100 --network-latency-ms 100 --download-kbps 10000` and add
`--cold-http-cache`. HTTP/CDP throttling does not affect the synthetic WebSocket,
so critical-path mode also applies the explicit RPC reply floor and serializes
received frame bytes at the selected download rate. HTTP and WebSocket traffic
use separate simulated pipes. The floor includes no real server work, and
serialized Gateway events may add their own fixture delay.

`run-1.critical-path.json` records document-clock start/readiness/capture times,
RPCs (including requests already in flight at interaction start), duplicate
groups, resource timings, and task/script/layout/style CPU milliseconds.
It also records compilation, DevTools command, other-task, and total thread CPU
counters when Chromium exposes them. Add `--cpu-profile` to save each selected
destination's `run-1.<route>.cpuprofile` and `run-1.<route>.trace.json` for attribution.
Profile base and candidate in separate invocations; bundle comparison accepts
only unprofiled runs.
Readiness is the first animation frame with visible transcript and enabled
composer (Chat), enabled composer (New Session), populated usable inventory
(Sessions/Cron/Agents), or visible Appearance controls and Settings search.
The record continues through 750 ms of RPC idle to retain secondary work; that
drain contributes to CPU totals but never to the readiness time. Use
`--thread-cpu-time` to exclude renderer descheduling from those totals on a loaded
host. These are
renderer-frame readiness measurements, not INP or proof that pixels reached a
physical display. Each destination also saves a synthetic screenshot.

Run ten serial interleaved base/head pairs per profile with identical fixture
options and report median, p95, min/max, RPC counts, and duplicate groups. Record
an A/A control on a loaded host; if that control exceeds the timing acceptance
band, use twenty interleaved pairs' CPU counters and structural request counts
for attribution. Keep traced/profiling captures separate from untraced timing
runs, and inspect request/chunk initiation against owner code before claiming
a causal waterfall: adjacent timestamps alone do not establish a dependency.

## Control UI development benchmark

Measure CLI-to-listening readiness without a browser or source edits:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-dev-loop.mts \
  --root <checkout> --mode warm --samples 5 --startup-only \
  --label candidate --out-dir <proof-dir>
```

For before/after comparisons, alternate checkouts with `--samples 1`, run serially,
and report the samples, median, p95, range, and recorded host load. `--mode cold`
passes Vite's `--force` to rebuild optimizer inputs; it does not clear OS caches.
`--mode warm` omits `--force` and assumes an existing valid optimizer cache.
Startup-only mode stops at Vite's listening banner and cannot prime an empty cache:
load the UI first, then check the retained server logs for re-optimization.
Readiness is separate from a loaded application's boot time.

Omit `--startup-only` to render the real chat loading component, change its first
skeleton width from 82% to 42%, and measure the visible update after the Vite
WebSocket connects. The benchmark rejects full-page reloads, saves synthetic
screenshots and logs, and restores its own source edit and temporary fixtures,
including on SIGINT/SIGTERM. Use a task-owned checkout without concurrent edits.

If file edits produce no Vite update, try the existing watcher opt-in:

```sh
CHOKIDAR_USEPOLLING=1 pnpm ui:dev
```

The same environment setting applies to the benchmark. Polling uses more CPU;
leave it opt-in for hosts where native directory events are unavailable. On macOS,
the Vite config resolves this setting before Chokidar selects its native backend.

## Formatting and lint selection

`lib/dev-tool.mts` selects the pinned Bun fork for local formatting and linting,
with oxfmt and oxlint fallbacks. CI gates on oxfmt and oxlint and checks Bun
parity in the same jobs. See the
[local development tools reference](https://docs.openclaw.ai/reference/test/local#openclaw-bun-fork)
for overrides, staging, and benchmark details. On a clean AWS `c7a.8xlarge`,
three interleaved runs measured `pnpm format` at 0.62 s with Bun versus 1.41 s
with oxfmt, and `pnpm format:check` at 0.62 s versus 1.38 s. The loaded Mac
sanity run measured 15.65 s versus 14.74 s for writes and 14.31 s versus 16.40 s
for checks; the write gain is not universal. An earlier native comparison on
the same AWS host measured S3 (`1.4.4-canary.1+ef37c31de`) at 23.3 s versus
oxlint 1.87.0 at 143.3 s summed across core, scripts, extensions, and UI:
6.15× faster at default threads, with no missing or extra diagnostics.
These native timings exclude wrapper preparation.
One loaded M3 Ultra Mac pair with S3 and oxlint 1.88.0 reported identical 243
diagnostics: whole `pnpm lint --format=json` times were 635.0 s for Bun and
912.7 s for oxlint, while summed native lint times were 1,037.8 s and 819.6 s.
The runs held the shared build lock, but background load reached 86 and the
first oxlint run generated declarations reused by Bun. This confirms parity,
not a Mac lint-speed gain; the oxlint override remains useful.
Bun receives the repository's existing configuration; no separate configuration
is maintained.

| Caller                                                                                                                                | Selection and reason                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `format:check`, `format:fix`, `format:diff`, `format:all`                                                                   | `run-format.mts` uses the selector. In CI, checks compare oxfmt and Bun on identical arguments and require oxfmt success.                                                                                                                      |
| `check.mts`, `check-changed.mts`, `ci-check-plan.mts`, `ci.yml`                                                                       | Consume `format:check`, including CI parity, without another job or runner.                                                                                                                                                                    |
| `pre-commit/format-staged.sh`, `.pre-commit-config.yaml`                                                                              | `run-node-tool.sh` uses the selector when dependencies exist; index-only formatting and partial staging remain owned by the hook.                                                                                                              |
| Dependency-less `pre-commit/run-node-tool.sh` recovery                                                                                | Retains its verified tooling-owner oxfmt fallback so code-only checkouts can satisfy the CI gate without installing dependencies.                                                                                                              |
| `run-lint.mts` and `run-oxlint-shards.mts`                                                                                            | `run-oxlint.mts` selects the executable after existing scope/resource preparation; all local shards honor `OPENCLAW_LINT_TOOL`. CI compares full diagnostic multisets on identical prepared configs and targets, then requires oxlint success. |
| `format-docs.mts`                                                                                                                     | Retains oxfmt for the dedicated docs CI gate and temporary-copy checks.                                                                                                                                                                        |
| `lib/format-generated-module.mts`, `generate-prompt-snapshots.ts`, `lib/codex-app-server-protocol-source.ts`                          | Retain oxfmt so generated modules, snapshots, and protocol bytes match CI regeneration.                                                                                                                                                        |
| `generate-control-ui-validators.mts`, `plugin-sdk-shipped-surface.mts`, `database-worker-inventory.mjs`, `qa/render-maturity-docs.ts` | Retain the oxfmt API for reproducible generated-artifact gates, including explicit per-artifact options.                                                                                                                                       |
| `crabbox-hydrate.yml`                                                                                                                 | Only verifies the oxfmt dependency is installed for CI; does not invoke formatting.                                                                                                                                                            |

There is no lint-staged formatter configuration; staged-file formatting belongs
to the hooks above. References in configuration, test fixtures, and scope
classifiers do not invoke a formatter.

## Script Families

The database-worker ratchet always analyzes current sources, including personal
credential writers. Its historical inventory reuses the build-artifact cache
under `.artifacts`: the key includes the base Git tree, analyzer/config source,
native compiler/API bytes, Node version, platform and checkout path. One base
generation is retained per cache root; changed inputs or damaged outputs rebuild
it. The complete semantic program is preserved on cache misses.

`pnpm check:database-dialect-ratchet` also runs `check-sql-portability.mts`.
It rejects multi-argument `fn("max" | "min", [...])` (including `fn.agg`),
equivalent raw SQL, and negative literal LIMITs in production `src`, `extensions`,
and `packages` code and SQL source files. Use the existing database-engine expression helpers. This
is a syntax check: it does not infer the values of variable argument lists or
prove general control-flow reachability.
The existing `--staged` mode checks the index, including this portability guard.

A physically SQLite-only owner or an explicitly `!postgres`-guarded expression
can put `/* pg-sqlite-only: <specific owner or guard reason> */` immediately before
that expression. The marker applies only to that expression, never a file or
function. Do not use it to suppress PostgreSQL-reachable SQL. Scalar extrema
helpers require non-NULL, SQL-typed operands: SQLite propagates any NULL, whereas
PostgreSQL greatest/least ignore NULL operands. Normalize nullable inputs at the
caller according to its contract.

- `check-*.mts` / `check-*.ts` / retained `check-*.mjs`: guardrails for architecture, docs, package
  contents, boundaries, workflows, and generated artifacts.
- `run-*.mjs` / `run-*.mts`: stable wrappers and typed implementations for Node, Vitest,
  oxlint, tsgo, and environment setup.
- `test-*.mts` / retained `test-*.mjs` / `test-*.sh` / `test-*.ts`: test planners, Docker lanes, live
  checks, and focused validation helpers.
- `docs-*` and `check-docs-*`: docs listing, link auditing, MDX checks,
  spellcheck, sync, and i18n glossary checks.
- `release-*`, `openclaw-npm-*`, and `plugin-*-release-*`: release preparation,
  package verification, and publishing helpers.
- `docker-*`, `test-docker-*`, and `test-live-*-docker.sh`: Docker E2E planning,
  rerun, timing, and live/package lane helpers.
- `gh-read*`, `label-*`, `sync-labels.ts`, and PR helpers: GitHub read,
  labeling, and maintainer workflow support.
- `generate-*`, `write-*`, `copy-*`, and `sync-*`: generated docs, metadata,
  package surfaces, and build artifact support.
- `lib/`: shared helpers imported by script entry points.

## Maintenance Rules

Fixed validators are emitted from their canonical schemas. Gateway, Control UI,
Codex, and fixed first-party generators share the standalone TypeBox emitter in
`lib/typebox-standalone.mts`; it binds explicit static captures and rejects
unsupported ones. Lobster uses the Ajv standalone emitter to preserve its
dependency-owned error contract.

| Schemas                                                     | Regenerate                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Gateway protocol                                            | `pnpm gateway:validators:gen`                                      |
| Control UI protocol                                         | `pnpm ui:validators:gen`                                           |
| Codex app-server protocol                                   | `pnpm codex-app-server:validators:gen`                             |
| Model registry, theme, TypeSafe, and computer-use contracts | `pnpm static:validators:gen`                                       |
| Lobster fixed payload/envelope contracts                    | `pnpm lobster:validators:gen --package-dir <pnpm-patch-directory>` |

Run `pnpm validators:check` after schema changes to verify the committed
validators are current. CI runs this freshness check alongside the normal build.
The Lobster generator writes only inside an explicit `pnpm patch` edit directory;
after regeneration, run `pnpm patch-commit <directory>` to refresh the dependency
patch. Its check command reads the installed patched schemas without modifying them.

- Read `scripts/AGENTS.md` before changing scripts.
- Keep package scripts, generators, generated-artifact checks, docs references,
  and workflow references aligned when touching a script path.
- Prefer existing wrappers instead of introducing a raw tool invocation.
- Add or update focused tests under `test/scripts/` when changing script
  behavior.

See also [Scripts](https://docs.openclaw.ai/help/scripts) for public-facing script guidance.

### Dynamic validator benchmark

`node --import ./scripts/tsx.mjs scripts/bench-dynamic-validators.mts <jit|aot> [iterations] [warmup] [mcp|plugin|llm|llm-coerce]` measures the actual validation owners. Compare five interleaved fresh baseline/candidate processes per fixture; import/setup and warm CPU/wall costs are reported separately.
