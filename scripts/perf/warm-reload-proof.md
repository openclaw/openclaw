# Real-Gateway warm reload proof

This opt-in diagnostic starts a **new loopback Gateway** from a built `dist/entry.js`,
seeds synthetic Team-shaped state, and records a fresh Chromium profile on chat and
dashboard deep links. It does not accept a live URL, use channels, copy operator
state, or require provider credentials. The model endpoint is the QA Lab mock
OpenAI server. The tool stops its browser, Gateway process tree, and mock provider
on completion or failure. Keep the shell alive until cleanup completes.

## Run

Run from the repository root with its installed dependencies and pinned Playwright
Chromium. Build the revision being measured first; `--dist` must point to that
revision's complete build. Build and fixture preparation are outside measurement.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
node --import ./scripts/tsx.mjs scripts/perf/warm-reload-proof.ts \
  --dist dist --ui-root dist/control-ui \
  --output .local/warm-reload-proof --sessions 3000 \
  --rtt-ms 80 --reloads 11 --capture-ms 8000
```

An existing dependency installation needs no reinstall. On a fresh Crabbox image,
use `corepack pnpm` directly; do not run `corepack enable`. The Gateway takes a free
port in **19600–19699**, binds only `127.0.0.1`, and uses a fresh state/config/home
inside the invocation's `.local/` artifact directory. The seeder refuses existing
state and paths outside this worktree's `.local/`. Every run allocates a unique
child directory and retains failed attempts. Output must therefore be under
`.local/`. Never point the tool at `~/.openclaw`.

For a small smoke run, use `--route chat --reloads 1`. `--route dashboard` selects
the other route. Default coverage is **one cold navigation and eleven warm
reloads per route**, each route in an independent initially empty browser context.
The browser cache is cleared before each route's cold navigation. The first URL
carries only the owned Gateway's synthetic token. After the cold capture, the tool
opens Details and waits for image/font readiness and a two-second persistence
window before starting warm reloads. Cold captures therefore show default Details
visibility; warm captures show the last visit's Details state. No DOM snapshot or
mock WebSocket replaces the real application, persistence, transport, or RPCs.

To measure a candidate UI against the same built server and fixture definition,
pass `--ui-root /absolute/path/to/candidate/dist/control-ui`. This uses the existing
Gateway custom UI root contract. `--dist /absolute/path/to/build/dist` selects a
different built Gateway. Record both build identities; the checkout revision in
the report identifies tooling, not independently supplied build directories.
Independent invocations seed identical shapes with fresh IDs/timestamps and fresh
browser state. They do not share a running Gateway or warmed profile.

## Fixture

The existing Team-shape generator owns the base inventory (3,000 sessions by
default), people, eight settled child runs, and eight disabled automations. The
tool appends nine tall assistant results to each route, including a 42-row table,
28-line code fence, a managed image attachment, session and synthetic PR links,
notice, tool activity, reaction, and task progress. A board widget is created
through the real Gateway RPC owner for the dashboard session. All names, text,
identities, media, and links are synthetic. `warm-reload-fixture.json` records the
exact shape; the rig does not claim to reproduce production traffic or authority.

## Capture and metric definitions

The viewport is **1720 × 1180 CSS pixels**, device scale factor one, dark theme,
headless repo-pinned Chromium. CDP network shaping applies **80 ms HTTP latency**
by default, 10 MiB/s throughput, and preserves HTTP caching. CDP HTTP emulation
does not add per-message latency to established WebSocket frames. This limitation
is explicit: it measures real local RPC handling plus shaped document/assets,
not a full remote WebSocket round trip. No CPU throttling or CPU profiler runs.

`Page.startScreencast` requests PNG, native viewport size, `everyNthFrame: 1`.
Every delivered frame is saved and acknowledged; analysis runs after capture.
Chromium may coalesce/drop compositor frames, so this is every **delivered** frame,
not proof that every display-vsync frame was observed. Raw frames and capture
timestamps remain available for inspection. Pre-navigation old-page frames are
retained in `frames.json`, with negative navigation-relative timestamps, and
excluded from new-document state counts. Native-resolution PNGs back analysis
and timestamped contact sheets; no video encoding changes the pixels.

The report distinguishes these boundaries:

- `fcpMs`: Chromium Paint Timing first contentful paint.
- `firstAppDomMs`: first sampled app shell presence; `firstMainDomMs`: first
  visible nonempty transcript row on chat, or the synthetic dashboard content's
  font-ready/two-animation-frame marker. These are DOM milestones.
- `firstAppCapturedPaintMs` and `firstMainCapturedPaintMs`: first delivered frame
  after the respective DOM milestone and FCP. These are **upper bounds**, not an
  assertion that every compositor frame was observed. Inspect dashboard sheets
  to verify the fixture content's paint.
- `firstPaintedRowsMs`: Chromium Element Timing for `openclaw-transcript`, when
  emitted. The probe annotates transcript text owners before paint, as the existing
  benchmark does. `finalRowsDomMs`: last sampled row identity, height, or text-length
  change. In-row changes
  and layout shifts are covered separately by pixel analysis and CLS.
- `helloHandledMs`: microtask after the existing Gateway owner publishes its
  connected snapshot. No mock transport or protocol hook supplies this time.
- `cls`: maximum standard layout-shift session window (one-second gaps, five-second
  cap, excludes recent input). Raw shift entries are retained.
- `loafBlockingMs` and `loaf`: native Long Animation Frame blocking durations and
  entries. The rAF DOM/mask probe and screencast have diagnostic overhead; do not
  compare these times with uninstrumented performance runs.
- `lastVisualChangeMs`: last significant pixel transition inside the fixed capture
  window. A late transition means the window may be censored; it does not prove
  the page settled. Increase `--capture-ms` when inspection shows unfinished work.

## Visual-state accounting

The pixel threshold is an RGBA channel delta greater than **12**, over at least
**max(32 pixels, 0.005% of the unmasked region)**. Each frame is compared with the
last accepted representative. A revisit to a prior representative is a transition
but does not increase the unique state count. Both numbers are reported. Sidebar,
header, transcript, Details, composer, and dashboard are counted independently
using their final visible viewport bounding boxes. Final boxes are a spatial
partition reference: early movement outside them is still counted in the whole
viewport. Region boxes may overlap; their counts must not be summed.

Every mask has a name, reason, and exact viewport rectangle in the JSON. Only
small spinner icons (at most 40 × 40), live elapsed clocks (100 × 40), and the
reconnect status area (240 × 40) may be masked. Rectangles encountered over the
capture are unioned for that reload. No skeleton, content panel, or text block is
hidden or removed by CSS. The tool does not focus an input during samples. If the
app focuses it, a collapsed caret uses its measured two-pixel rectangle, or the
padded text origin for an empty editable. These masks are reported too.
If a new animated element escapes these selectors, inspect
the raw frames and extend an explicit narrow mask rather than raising thresholds.
The **unmasked state census** is always emitted alongside the masked census.

Each reload directory contains `frame-*.png`, `frames.json`, `final.png`,
`contact-sheet-*.png`, and `reload.json`. The top `report.json` records revision,
build paths, browser version, host load/resources, shaping, fixture, masks, HTTP
responses, RPC counts/bytes, errors, metrics, and region timelines. Contact sheets
contain native-size tiles, up to six per page. Inspect all sheets for cold and
warm samples on both routes before claiming a baseline.

This tooling lane's acceptance gate is delivery and inspection, not an improvement
claim. Performance comparisons belong on a quiet fixed-instance Crabbox lease
with interleaved baseline/candidate samples. A loaded development Mac can establish
fixture/capture correctness and deterministic visual counts; its timing samples
must be labeled diagnostic, not a performance result.
