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
use `corepack pnpm` directly; do not run `corepack enable`. The Gateway, its native
board sandbox at Gateway+1, and the synthetic admission proxy use distinct free
ports in **19600–19699**. Calibration uses another temporary port and avoids the
lazy sandbox listener. All bind only `127.0.0.1` and use a fresh state/config/home
inside the invocation's `.local/` artifact directory. The seeder refuses existing
state and paths outside this worktree's `.local/`. Every run allocates a unique
child directory and retains failed attempts. Output must therefore be under
`.local/`. Never point the tool at `~/.openclaw`.

For a small smoke run, use `--route chat --reloads 1`. `--route dashboard` selects
the other route. Default coverage is **one cold navigation and eleven warm
reloads per route**, each route in an independent initially empty browser context.
The default `--admission signed-in` installs a random HttpOnly session cookie in
Chromium for the owned loopback proxy. The proxy checks that cookie for HTTP and
WebSocket requests, strips client-supplied identity/forwarding/scope headers, and
injects one synthetic user through the existing trusted-proxy contract. The native
protected root registers the service worker's `session-entry=1` navigation mode.
That worker fetches the protected chat-entry response with the cookie and returns
it as one document; the rig does not rewrite navigation or suppress redirects.
Every signed-in capture requires exactly one top-level document. This reproduces
the product admission semantics, not Team's external OAuth/TLS/CDN implementation.
See [trusted proxy auth](../../docs/gateway/trusted-proxy-auth.md) and the
[deep-link admission contract](../../docs/web/urls.md#public-session-transcripts).

`--admission token` retains the native CLI browser-handoff path for diagnosis;
its chat reload may traverse the public reader and a second document. Fixture
RPC setup always uses the built CLI's authentication owner, with a generated
local-only password in signed-in mode. No real credentials are read.
The browser opens the app root first, then leaves the app for the health document, clears IndexedDB,
Cache Storage, HTTP cache, and derived local/session storage. Device credentials
and, in signed-in mode, the HttpOnly proxy session cookie remain, defining **signed-in,
client-data-cold**, rather than a new unauthenticated browser or a cold V8 process.
After the cold capture, the tool
opens Details on chat and waits for image/font readiness and a two-second persistence
window before starting warm reloads. A read-only cache inventory verifies that an
owned transcript snapshot exists for the exact route; otherwise warm proof stops.
Cold captures therefore show default Details
visibility; warm chat captures show the last visit's Details state. Dashboard keeps
its native closed Details state. The current router uses `/dashboard/...` for the
dashboard face; the historical `/chat/.../dashboard/...` shape selects chat.
No DOM snapshot or
mock WebSocket replaces the real application, persistence, transport, or RPCs.

Inspect the PNGs to identify the first frame containing the app shell, actual main
content, and dashboard content. Check each selected frame and its immediate
predecessor. DOM readiness can precede the compositor image by multiple frames;
the recorder's candidate timestamps are not paint measurements.

Save the observations as `paint-audit.json`:

```json
{
  "observations": [
    {
      "route": "chat",
      "run": "cold",
      "appFrame": "frame-00003.png",
      "mainFrame": "frame-00014.png",
      "inspected": true
    }
  ]
}
```

Include exactly one observation for every captured run. Compare observations also
include `"arm": "base"` or `"arm": "candidate"`; run directories are then
`<arm>/<route>/<run>`. Dashboard observations
also require `dashboardFrame`. The app boundary is the first new-document shared
shell skeleton or app chrome, excluding the public reader and the previous page.
Main content means actual transcript text; dashboard content means the fixture
widget rather than its loading skeleton. Then compute observed paint times from
the selected frames' original navigation-relative clocks:

```sh
node --import ./scripts/tsx.mjs scripts/perf/warm-reload-proof.ts \
  --audit-report .local/warm-reload-proof/<run>/report.json \
  --paint-audit .local/warm-reload-proof/<run>/paint-audit.json
```

This offline step writes `audited-report.json` and preserves the raw report. It
records the selected and preceding frames, capture/build identity, and separate
analysis revision. In compare mode it also regenerates `comparison.json`,
`comparison.md`, and the side-by-side sheets from the audited paint results.
Audited run directories resolve to the local extracted capture paths; the raw
remote paths remain in the immutable report. Its visual inspection attestation is explicit; it does not
infer content from DOM readiness or claim to observe every display-vsync frame.

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

Signed-in proof also seeds three other profiles with distinct synthetic avatars.
Each signs in through its own HttpOnly proxy cookie and opens both routes through
the real UI. Peer JavaScript is paused without hiding its pages before measurement,
preserving live viewer declarations without competing renderer work. Both measured
arms must finish warming with exactly three other viewers in the header; an empty
facepile cannot qualify a header-presence comparison.

## Capture and metric definitions

The viewport is **1720 × 1180 CSS pixels**, device scale factor one, dark theme,
full repo-pinned Chromium in [new headless mode](https://playwright.dev/docs/browsers#chromium-new-headless-mode),
not the separate headless shell. Playwright normally disables `PaintHolding`.
The rig reads its owned browser's actual feature switches, removes only that
disabled member, explicitly merges it into enabled features, and verifies the
resulting command line. Other default feature members remain unchanged.
`browserConfiguration` records the sanitized effective configuration.

Before any product capture, automatic synthetic controls calibrate the same
browser and CDP surface. A 300ms no-paint document must show old → complete (two
states), while a 900ms document must show old → blank at the holding deadline →
complete (three). Their native PNGs, contact sheets, release/paint times, and
`paintHoldingCalibration` report are retained. A missed fast deadline or wrong
sequence is a setup failure; no product verdict is produced. These controlled
delays are the calibration workload, not test synchronization. Headless compositor
calibration still does not claim a physical headed window or every display vsync.

CDP network shaping uses an **80 ms latency setting**
by default, 10 MiB/s throughput, and preserves HTTP caching. Chrome supports
[WebSocket throttling](https://developer.chrome.com/docs/devtools/network/reference/#throttle-websocket-connections).
The browser transport emulator is not a fixed-delay wrapper around each RPC;
use the recorded send/response event-handler intervals rather than assuming every
RPC takes 80 ms. These intervals include server work and renderer/CDP dispatch;
they are not calibrated wire RTT measurements.
No CPU throttling or CPU profiler runs.

`Page.startScreencast` requests PNG, native viewport size, `everyNthFrame: 1`.
Every delivered frame is saved and acknowledged; analysis runs after capture.
Chromium may coalesce/drop compositor frames, so this is every **delivered** frame,
not proof that every display-vsync frame was observed. Raw frames and capture
timestamps remain available for inspection. Missing or non-finite compositor
timestamps fail capture; arrival-clock fallback is diagnostic only, never a
measurement. The recorder waits for a delivered pre-navigation compositor surface before
starting navigation. Those actual frames remain in `frames.json` with their
negative navigation-relative times. Warm display timelines carry the last
observed old surface forward at time zero, then consume every delivered
post-navigation surface, including any repeated held old-page images. The
`oldPage` record reports the source frame's actual observation time and the first
observed pixel difference. The carried reference is explicitly not a newly
captured frame at zero; lack of a delivered replacement does not establish every
display vsync. This headless compositor evidence does not claim an OS screen
recording. Warm pixel and visible-state counts include the old page, so the
campaign's target old page → complete page is two states. Cold health-page
references are excluded. Native-resolution PNGs back analysis
and timestamped contact sheets; no video encoding changes the pixels.

The report distinguishes these boundaries:

- `fcpMs`: Chromium Paint Timing first contentful paint.
- `firstAppDomMs`: first sampled app shell presence; `firstMainDomMs`: first
  visible nonempty transcript row in the main region, or the synthetic dashboard
  content's font-ready/two-animation-frame marker when the board occupies main.
  These are DOM milestones. Dashboard content also has a separate
  `firstDashboardContentDomMs` marker when its board is beside the transcript.
- `firstAppCandidateFrameMs`, `firstMainCandidateFrameMs`, and
  `firstDashboardCandidateFrameMs`: first delivered frame after the respective
  DOM milestone and FCP. They can still show old pixels or skeletons. They are
  navigation aids for inspection, not paint times or paint upper bounds.
- `auditedPaint` in the audited report: first visually verified delivered frames
  for app, main content, and dashboard. Their timestamps bound the observed frame
  sequence; the preceding frames remain linked for boundary verification.
- `firstPaintedRowsMs`: Chromium Element Timing for `openclaw-transcript`, when
  emitted. The probe annotates transcript text owners before paint, as the existing
  benchmark does. The first eligible text entry can be later than the first visible
  rows; use `auditedPaint.main` for the inspected pixel boundary.
  `finalRowsDomMs`: last sampled row identity, height, or text-length
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
reference: early movement outside them is still counted in the whole
viewport. Region boxes may overlap; their counts must not be summed.

Every persistent mask has a name, reason, and exact viewport rectangle in the JSON. Only
small spinner icons (at most 40 × 40), live elapsed clocks (100 × 40), and the
reconnect status area (240 × 40) may be masked. Rectangles encountered over the
capture are unioned for that reload. No skeleton, content panel, or text block is
hidden or removed by CSS. The tool does not focus an input during samples. If the
app focuses it, a collapsed caret uses its measured two-pixel rectangle, or the
padded text origin for an empty editable. These masks are reported too.
If a new animated element escapes these selectors, inspect
the raw frames and extend an explicit narrow mask rather than raising thresholds.
The **unmasked state census** is always emitted alongside the masked census.

The separate `visibleChangeCensus` groups recognized shimmer and fade phases.
The browser records explicit animation targets, their rectangles, and fingerprints
of content, attributes, descendant geometry, typography, colors, and hidden versus
visible state. Only skeleton shimmer and opacity/visibility-only fades qualify;
fade subtrees containing images, canvas, video, or iframes are excluded, and targets
are bounded to 64 elements. Intermediate nonzero opacity is normalized; content,
identity, geometry, and visibility changes stay distinct. A pair can ignore pixels
inside an animation rectangle only when the same target and fingerprint occur on
both samples. Masks are pair-specific, so a skeleton rectangle cannot hide its
replacement content. Unexplained changes retain the original pixel threshold and
subthreshold changes accumulate. `suppressedAnimationPairs` reports every rectangle.
Fade grouping additionally requires actual pixel contrast (luminance standard
deviation ≥4 on each side) and structure correlation ≥0.999. A blank or faint
pre-content surface cannot disappear merely because DOM metadata was ahead of
paint. The probe's accumulated `animationProbeMs` is retained as instrumentation
overhead.

This is a conservative visible-change heuristic, not a claim to model human
perception or establish compositor paint from DOM data. DOM animation observations
can lag or precede the delivered surface. Inspect `visible-contact-sheet-*.png`
next to raw pixel sheets; actual first content still requires a paint audit.
Whole-page and per-region timelines list every accepted change with original
navigation-relative time, frame, state, and changed pixels. Region names are
sidebar, header, transcript, details, composer, and dashboard (the board).

Each reload directory contains `frame-*.png`, `frames.json`, `final.png`,
`contact-sheet-*.png`, and `reload.json`. `paint-audit.json` and
`audited-report.json` add inspected paint observations. The top `report.json` records revision,
build paths, browser version, host load/resources, shaping, fixture, masks, HTTP
responses, RPC counts/bytes, errors, metrics, and region timelines. Contact sheets
contain native-size tiles, up to six per page. Inspect all sheets for cold and
warm samples on both routes before claiming a baseline.
The rig records every top-level document request. Redirect/interstitial time stays
in the pixel/RPC timeline: times are anchored to the original document request,
with the final document offset recorded. Native LoAF and CLS cover the final app
document; prior documents remain in the filmstrip and FCP lifecycle census.
A final page missing required region bounds fails capture. Warm samples require
visible Details on chat too. Dashboard reports closed Details as unmounted.
Token-mode multiple documents remain a recorded outcome; signed-in mode fails
if the one-document admission contract is not met.

This tooling lane's acceptance gate is delivery and inspection, not an improvement
claim. Performance comparisons belong on a quiet fixed-instance Crabbox lease
with interleaved baseline/candidate samples. A loaded development Mac can establish
fixture/capture correctness and deterministic visual counts; its timing samples
must be labeled diagnostic, not a performance result.

## Compare two UI builds

Run one command on a quiet, fixed-instance Crabbox lease:

```sh
node --import ./scripts/tsx.mjs scripts/perf/warm-reload-proof.ts \
  --dist dist --base origin/main --candidate HEAD \
  --output .local/warm-reload-comparison --reloads 11 --rtt-ms 80
```

`--base` and `--candidate` each accept a built UI directory containing
`index.html`, a complete dist directory containing `control-ui/index.html`, or a
Git ref. A ref is pinned to its commit before an isolated detached checkout is
created under the invocation's `.local/` directory. The tool installs that
checkout's frozen dependencies and runs `corepack pnpm build`, including the
completed plugin UI distributions consumed by the UI build; it never
switches the visible checkout's branch. These builds happen serially before
capture. The tool removes its source checkouts during cleanup, and retains the
captured build identity and UI index hash in the report. An existing build is
used as supplied and gets a hash, without an invented source revision. Supplying
the same input for both arms reuses one prepared build and provides an A/A
control.

This compares **UI builds against the same `--dist` Gateway and the same seeded
durable state**. It does not compare Gateway changes between refs. Use the
appropriate prebuilt server in `--dist`; no server build is implicit. The rig
copies each selected UI build into its owned custom UI root while both arm
pages are frozen, outside measured navigation. The native custom-root contract
reads fresh bytes and only joins concurrent reads
(`src/gateway/server-control-ui-root.ts`); it does not retain the bundled-root
asset cache. The tool swaps complete copied directories, so a removed candidate
asset cannot fall through to a leftover base file. The Gateway process, its
resident data, and its caches stay warm throughout the comparison. Base and candidate keep separate browser contexts and caches. Each
route records one signed-in client-data-cold navigation per arm, then interleaves
base/candidate warm reloads in eleven pairs, alternating AB/BA order. Inactive
arm pages are frozen through CDP so they cannot generate competing UI work or
RPCs during the active sample. State is seeded once; it is not
regenerated between arms. The browser visits and normal read-side bookkeeping
are part of both arms' real flow.

The primary campaign state metric is **chronological visible-state occurrences**
(`visibleStateOccurrences`, the visible census timeline length), including the
carried old-page state on warm reloads. A revisit counts again: alternating
between two unique images many times must not satisfy the old-page → complete-page
two-state goal. Unique representatives remain alongside occurrences for the
visible, masked-pixel, and unmasked-pixel censuses.

`comparison.json` and `comparison.md` report median, Q1/Q3, every candidate-minus-
base paired delta, and the number of better/worse pairs for visible-state and
pixel counts, last changes, hello, FCP, Element Timing rows, final row DOM facts,
LoAF blocking, and CLS. Uninspected app-content paint is unavailable, never
replaced by a DOM-correlated candidate time. Cold captures and their full
per-region change timelines remain in `report.json`.

`comparison-sheets/<route>/warm-<pair>/` contains native-resolution side-by-side
contact sheets. Rows align the union of both arms' accepted visible-change
timestamps. Each tile labels its representative frame's own time: holding a
representative for alignment does not create a new sampled frame. Inspect the
original frame sequence before judging a subtle transition. The visible-change
census is a reported animation-collapse heuristic; unmasked pixels and explicit
animation provenance remain available as controls. An A/A run qualifies noisy
metrics before using this report to reject a small change.
