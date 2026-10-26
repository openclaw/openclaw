# Talk performance, round 2

Baseline: `5f71bbf09e6` (current `origin/main` at the start of this round).

## Workload and acceptance, recorded before measurement

Use `scripts/bench-control-ui-talk.ts` with the production Control UI, synthetic
oscillator microphone, native audio-element playback, and the existing synthetic
provider contract. Every browser run is headless. Hidden observations must report
`document.visibilityState === "hidden"`.

Measure ordinary listening, speaking, and responding on desktop (1440×1000) and mobile
(390×844), at 1× and 4× CPU. Separately measure idle and listening with keyboard
focus on Stop and its tooltip continuously open. Diagnostic traces, callback
counters, frame samples, and screenshots are separate from paired CPU windows.

Compare task/script/layout/style CPU per second using Chromium's timestamp
interval. Keep renderer-process CPU as raw deltas from its wider endpoint calls;
those calls do not record a separate duration for a precise per-second rate. Rank
source-mapped samples and inspect native tasks as well as JavaScript. Count
analyser reads, timer/rAF/observer callbacks, and visible meter writes. Record host
load and use a base/base A/A control because this is a shared Mac.

For candidate changes, use at least ten serial interleaved pairs; use twenty
when A/A shows noise. Target a 40% reduction in 4× task CPU for ordinary speaking,
listening, and idle with the tooltip. A clean measured 5% win is landable even if
the target remains open. Preserve visuals, frame behavior, audio behavior, and
latency: median regression ≤5% and p95 no worse, or ten additional pairs put the
cell inside the acceptance band. A >20% attributable regression blocks landing.

Investigate hidden caption reveal separately with A/A, comparing wall latency,
renderer task CPU, and dispatch/scheduling gaps. Native `play()` resolution is a
local playback-start probe, not provider or acoustic latency. No battery-life
claim follows from this synthetic benchmark.

The round-2 runner explicitly clears hover/focus tooltips for ordinary cells and
does not install a transcript observer when no transcript is expected. Earlier
ordinary samples could retain the Stop hover tooltip. Both bundles use this same
corrected runner; these results must not be combined with round-1 samples.
`speaking` is microphone activity; `responding` exercises the TTS `thinking`
animation via a valid synthetic response lifecycle, with native playback active.
Listening and connected-idle both retain the silent native audio graph. They do
not claim that real browser audio has stopped. Diagnostic observer counts include
fixture-owned observers.

## Results

The initial instrumented baseline (one 3-second observation per cell; host load
58–83) ranks native frame processing first. Values below are task CPU ms/s;
single traced samples identify owners and are not acceptance results.

| State            | Desktop 1× | Desktop 4× | Mobile 1× | Mobile 4× |
| ---------------- | ---------: | ---------: | --------: | --------: |
| Listening        |       2.74 |      10.11 |      1.75 |      3.56 |
| Speaking         |      35.89 |     147.71 |     32.73 |    132.65 |
| Responding / TTS |      32.32 |     105.84 |     23.04 |     85.98 |
| Idle             |       1.22 |      29.94 |      2.04 |      3.11 |

`ScheduledActionSendBeginMainFrame` is the posting location attached to native
main-frame tasks, not a sampled native hotspot. On desktop 4×, speaking/responding
contained 173/181 main-frame tasks and 171/181 style updates of seven elements
over three seconds, with no layout or paint events. Their nested style CPU was
44.35/17.42 ms/s, prepaint 21.20/23.66 ms/s, and internal intersection processing
7.24/9.81 ms/s; these categories must not be added together. Speaking wrote the
seven bar styles about ten times per second; responding wrote none but maintained
the CSS animation's native frame work. The trace does not identify which native
intersection targets contribute or establish anchor-positioning as the cause.

Quiet ordinary listening and idle produced no meter writes, observer deliveries,
or JavaScript rAF callbacks. The analyser still sampled approximately 10 times
per second. One desktop 4× idle observation contained 34.7 ms of GC and is not a
steady idle estimate. Across the complete diagnostic run, sampled Talk audio
math accounted for 0.710 ms; no PCM/base64 processing path is involved in the
native WebRTC fixture. These single traced samples identify owners; paired
untraced comparisons below determine acceptance.

All four speaking traces contained zero GC events. Responding contained zero
except desktop 1× (two events, 4.56 ms total). The desktop 4× idle outlier above
contained two events totaling 34.72 ms; mobile idle contained one short event at
each rate (0.61/1.37 ms). GC does not explain the continuous active-frame cost.

### Initial stationary-tooltip results (v2; provisional)

These observations predate the strict in-window network check. The completed v4
confirmation below is the acceptance evidence; this table is retained history.

Twenty interleaved pairs per viewport, untraced three-second intervals at 4×.
All 320 observations passed. CPU entries are median / p95 in ms/s.

| Viewport / state             |     Base task | Candidate task | Median change |      A/A base | A/A comparison |
| ---------------------------- | ------------: | -------------: | ------------: | ------------: | -------------: |
| Desktop, listening + tooltip | 36.32 / 43.78 |   6.99 / 10.89 |        −80.8% | 35.58 / 40.17 |  37.34 / 43.70 |
| Desktop, idle + tooltip      | 33.21 / 40.12 |    4.40 / 7.22 |        −86.8% | 31.07 / 34.76 |  33.93 / 37.77 |
| Mobile, listening + tooltip  | 34.12 / 40.65 |   7.52 / 13.55 |        −78.0% | 33.91 / 39.31 |  34.89 / 39.89 |
| Mobile, idle + tooltip       | 31.16 / 35.45 |    4.30 / 5.68 |        −86.2% | 30.78 / 35.70 |  30.58 / 35.19 |

| Viewport / state   | Base min–max ms/s | Candidate min–max ms/s |
| ------------------ | ----------------: | ---------------------: |
| Desktop, listening |       31.08–48.11 |             2.52–17.73 |
| Desktop, idle      |       25.37–51.43 |              1.24–8.89 |
| Mobile, listening  |       27.48–52.34 |             4.20–14.56 |
| Mobile, idle       |       26.57–36.04 |              1.41–6.04 |

Host one-minute load ranged from 20.20 to 78.14. The A/A median idle increase
is about 9%, confirming measurable host variation.
Both candidate CPU p95s improve substantially;
the effect is much larger than the unchanged control's movement.

The frozen candidate predates the final paint-property filter and border-box
observer fixes. These stationary fixtures have no ancestor animation or changing
anchor box, so neither fix changes their measured work. The final source passed its production build, strict asset check, and the
focused Chromium and WebKit behavior checks.

### Cold native playback-start probe

Twenty browser starts per side, first `play()` call per browser, median / p95 ms:

| Viewport   |            Base |       Candidate |        A/A base |  A/A comparison |
| ---------- | --------------: | --------------: | --------------: | --------------: |
| Desktop 4× | 305.60 / 385.00 | 332.20 / 418.60 | 339.90 / 431.50 | 321.25 / 398.00 |
| Mobile 4×  | 285.50 / 379.70 | 284.20 / 809.10 | 308.90 / 415.90 | 313.80 / 485.20 |

Cold native playback is noisy on this shared host. Candidate maxima reached
807.5 ms desktop and 2,378.4 ms mobile; unchanged A/A maxima reached 1,686.4 ms
and 730.8 ms. The mobile candidate tail is outside the band in this early partial-interval
measurement. It is retained here as adverse evidence. The final whole-gesture
check below supplies a second unlock-clip observation, not remote-stream
acceptance; neither probe measures end-to-end acoustic audio latency.

### Stationary tooltip diagnostic

One 3-second base/head pair per cell, with counters and inspected screenshots:

| State                                      |   Desktop 1× |    Desktop 4× |    Mobile 1× |    Mobile 4× |
| ------------------------------------------ | -----------: | ------------: | -----------: | -----------: |
| Listening + Stop tooltip, base → head ms/s | 14.26 → 4.02 | 34.62 → 10.64 | 12.81 → 5.71 | 32.13 → 9.22 |
| Idle + Stop tooltip, base → head ms/s      | 12.45 → 3.08 |  31.29 → 4.39 | 11.43 → 0.88 | 29.88 → 2.51 |
| rAF callbacks/s, base → head               |     60.5 → 0 |      60.2 → 0 |     60.3 → 0 |     60.2 → 0 |

All 16 observations passed. Stop focus, its open tooltip, and document focus
remained active. There were no recurring mutation, resize, or intersection
callbacks in the candidate window. Analyser sampling remained approximately
10 Hz; meter writes remained zero. These instrumented samples establish the
removed work; the untraced 20-pair A/B and A/A results above establish its size.

The owner now watches position, resize, ancestor mutations, scrolling, and
signaled transform/motion-path animation instead of polling every frame.
The independent review found that the initial animation filter also followed
paint-only color/shadow animations; the revised filter leaves those stationary.
Layout changes remain observed. Accepted edge cases: unannounced
pure-scale WAAPI on unchanged ancestors and fully clipped motion can await a
subsequent invalidation; current callers do not use that pattern. Position
observer delivery can trail motion by one rendering frame. Hidden mutations can
still deliver observer callbacks; this does not claim all hidden callbacks stop.

### Native-audio counterfactual

A separate same-bundle diagnostic suspended both native AudioContexts and paused
the audio element on one side only. Endpoint checks confirmed suspension.
The normal A/A sides remained untouched. Task CPU differences were inconsistent
with the A/A spread, so this is not evidence for a product change. Every hidden
sample reported `visibilityState === "hidden"`, zero analyser reads, and zero
JavaScript animation callbacks. This fixture does not measure real WebRTC codec
or network CPU: its peer connection and SDP/provider messages are synthetic.

## Rejected experiments

A 30 Hz direct-DOM prototype retained the seven bars and interpolated their
transforms outside Solid. One desktop 4× diagnostic pair changed speaking
173.45 → 145.60 ms/s (−16.1%) and responding 136.92 → 129.17 (−5.7%), while
script CPU increased. A single-canvas 30 Hz prototype instead changed speaking
161.83 → 85.52 (−47.2%) and responding 143.79 → 65.22 (−54.6%). Inspected
synthetic frame captures looked consistent. These are single diagnostic pairs,
not acceptance results. The subsequent production canvas, visual coverage, and
repeated 4× comparison are recorded below. Neither prototype is part of the
tooltip change.

A direct `transform` binding in place of the seven inherited `--talk-bar-scale`
properties did not remove the active rendering cost. In a single instrumented
pilot, desktop 4× speaking changed 113.27 → 110.58 ms/s, while mobile changed
111.23 → 123.29 ms/s. At 1× the changes were 28.47 → 28.02 and 28.18 → 31.80 ms/s.
This is not a clean win; the binding and CSS changes were removed. These pilot
numbers are diagnostic, not calibrated effect sizes.

The compositor diagnostic confirms that all seven responding bars already own
accelerated transform and opacity layers. Their main-thread cost cannot be
attributed simply to missing layer promotion. Moving status keyframes from
`transform` to individual `scale` produced no established improvement (one
instrumented desktop 4× pair: 118.21 → 105.96 ms/s). It remains an experiment,
not a production change.

Removing only the Stop trigger's anchor name did not improve ordinary speaking
(one 4× diagnostic pair: 122.54 → 122.24 ms/s). The responding difference was
97.51 → 93.02 ms/s in that same single pair, below a justified win. No production
anchor-name change was retained from this test.

A `contain: layout style` meter boundary likewise did not improve speaking
(one 4× pair: 126.33 → 131.36 ms/s); responding changed 99.22 → 97.16 ms/s.
The CSS-only experiment was not promoted to production.

Removing all document anchor names likewise failed to improve the active state
(one 4× pair: speaking 116.55 → 132.46 ms/s; responding 92.12 → 98.71 ms/s).
This rules out retaining a speculative anchor-registration rewrite in this PR.

An AudioWorklet is not a free battery optimization: the current analyser owner
scans 512 samples at 10 Hz (5,120 JavaScript samples/s), while an audio processor
at 48 kHz normally runs approximately 375 callbacks/s. A gated ring buffer could
avoid continuous RMS scans, but still adds quantum callbacks and copying. No
worklet change is included without whole-renderer/audio-process evidence.

## Measurement limits

Callback counters start before process snapshots and stop after the final
snapshots, so their observation window is slightly wider than the CDP CPU
interval. Rates reported against that interval are approximate; a zero recurring
callback count remains exact. `hiddenAndReveal` adds two sampled intervals and
omits the intervening artifact/inspection gap; it is not continuous end-to-end
CPU. Renderer-process CPU at 4× includes all renderer threads and the CPU-throttling
mechanism; its roughly 800–1,000 ms/s in quiet cells is not evidence of browser
audio cost or battery drain. Page task/script CPU and source-attributed work are
the acceptance metrics. External transcript delivery targets 20 Hz but can catch up in bursts under
host load. Browser-local reveal latency avoids Node polling and restoration
delays; reveal CPU includes fixture scans and all application visibility handlers.

The earlier isolated review found no actionable P0–P2 issues after narrowing
geometry animation tracking and observing the anchor's border box. The latter
matches the rectangle mirrored by the proxy and covers stylesheet-driven padding
shrinkage without an anchor attribute mutation. Final Chromium and WebKit runs
each passed all 19 overlay cases. UI typecheck, scoped UI lint, and production
Knip passed. The final production build, strict asset check, scripts typecheck,
and scoped scripts lint also passed.

## Final overlay assets

Same-host frozen production builds: startup JavaScript 271,312 → 271,570 B gzip
(+258 B), with five startup requests unchanged. Startup CSS remains 31,981 B
and one request. Chat boot grows 1,233,436 → 1,234,299 B (+863 B); New Session
grows 750,062 → 751,016 B (+954 B). The strict checker reports no violations
or warnings. This small shared-owner cost accompanies the measured 78–87%
stationary-tooltip CPU reduction in the initial comparison; the final v4 table
below supersedes that effect size. No audio or transcript owner changes.

## Reveal attribution

A same-head diagnostic (16 observations, four per viewport/rate) verified hidden
state, all 20 offered caption chunks, and retained transcript-row identity.
Visibility-to-DOM ranges were 11.6–13.6 ms desktop 1×, 88.7–104.0 ms desktop 4×,
9.5–15.4 ms mobile 1×, and 98.5–121.0 ms mobile 4×. These small cells diagnose
the path; they are not tail acceptance samples.

A separate desktop 4× reveal-only profile measured 98.7 ms visibility-to-DOM
and 135.0 ms to the second browser animation frame. Reveal task/script CPU was
153.669/131.455 ms. Solid flush accounted for 117.540 ms inclusive, including
38.69 ms in the parked whole-frame projection and 33.72 ms in `runtime.render`.
`renderChatPaneLayout` and `renderPaneHeader` contributed 13.78 and 8.10 ms
inclusive. Nested numbers must not be added. Fixture/evaluation samples were
2.27 ms. The external profiler's artifact writes inflate its Node wall clock,
so only browser-local clocks are used here.

Relaxing hidden parking would change lifecycle behavior. A naive shallow
projection of all ChatProps also eagerly reads its live `stream` getter,
subscribing hidden panes to each delta. Neither change is accepted; the paired
results below do not justify changing the hidden-parking contract.

## Final-head reveal calibration

Two serial ten-pair runs: 160/160 observations passed, all natively hidden and
all retaining their caption row through reveal. Each cell has 20 samples per
side. One-minute host load ranged 15.77–49.39. Values are median / p95.

| Viewport / comparison |      Unlock play base → head (ms) |     Reveal frame base → head (ms) |      Reveal task base → head (ms) |
| --------------------- | --------------------------------: | --------------------------------: | --------------------------------: |
| Desktop / AB          | 280.95 / 324.00 → 297.20 / 368.60 | 122.90 / 151.80 → 127.10 / 149.40 | 132.65 / 161.44 → 137.14 / 161.95 |
| Desktop / AA          | 294.80 / 737.30 → 284.50 / 732.30 | 125.15 / 144.50 → 126.75 / 147.00 | 134.94 / 155.18 → 136.28 / 157.28 |
| Mobile / AB           | 262.40 / 353.20 → 269.45 / 297.30 | 118.40 / 142.70 → 125.30 / 142.60 | 129.45 / 153.83 → 134.76 / 154.16 |
| Mobile / AA           | 279.40 / 367.60 → 276.55 / 359.10 | 120.05 / 159.40 → 124.25 / 135.60 | 130.59 / 168.00 → 135.08 / 146.70 |

| Viewport / comparison | Paired unlock play median | Paired reveal frame median | Paired reveal task median | Paired reveal script median |
| --------------------- | ------------------------: | -------------------------: | ------------------------: | --------------------------: |
| Desktop / AB          |                   +18.84% |                     +1.91% |                    +2.38% |                      +4.59% |
| Desktop / AA          |                    -3.64% |                     +1.69% |                    +2.36% |                      +3.89% |
| Mobile / AB           |                    -0.34% |                     +0.84% |                    +0.61% |                      +0.08% |
| Mobile / AA           |                    +4.04% |                     +1.96% |                    +3.08% |                      +1.91% |

The mobile raw reveal-frame median rises 5.8%, while its paired median rises
0.84% and p95 is unchanged. Reveal task medians remain within 5%; task p95
changes below 1% are noise under the campaign rule. These isolated desktop play-duration samples fail the band and do not by
themselves establish unchanged cold latency; the whole-gesture probe below
rechecks the unlock clip on the same final builds. Remote-stream readiness is a
separate boundary, measured by the later source-classified probe.

## Playback interval attribution

A separate four-observation, desktop-4× startup profile spans Start through the
native readiness assertion. Base/head task CPU was 478.95/495.87 ms and script
CPU 200.29/213.41 ms; unchanged A/A was 531.36/451.19 and 223.96/191.70 ms.
This tiny traced cell diagnoses the boundary and establishes no effect size.
The first native play promise lasted 168.8/186.9 ms, while the wider measured
interval lasted 706.28/611.96 ms. Unchanged A/A showed the same disagreement
(206.8/276.5 ms versus 680.51/505.90 ms). The browser-local Start-gesture probe
below separates that partial duration from gesture-to-unlock readiness.

The CPU profile itself extends beyond the bounded CDP metric interval. Its
raw sampled totals must not be treated as interval CPU percentages.

## Whole-gesture startup check

Twenty serial interleaved A/B and A/A pairs on desktop at 4× completed all
80/80 observations. This untraced, browser-local probe starts on the actual
Start pointerdown and ends when the first native `play()` promise resolves.
It uses the same frozen base-current and head-final builds as final calibration.

| Metric (median / p95)       |        A/B base |        A/B head |       A/A first |      A/A second |
| --------------------------- | --------------: | --------------: | --------------: | --------------: |
| Gesture to unlock ready, ms | 288.65 / 439.90 | 281.95 / 335.30 | 268.00 / 368.10 | 294.90 / 335.70 |
| Native play duration, ms    | 271.90 / 419.20 | 265.40 / 320.20 | 252.00 / 351.50 | 276.35 / 319.70 |
| Startup task CPU, ms        | 451.76 / 898.94 | 474.32 / 752.55 | 484.79 / 729.25 | 488.67 / 803.11 |
| Startup script CPU, ms      | 200.83 / 219.00 | 196.91 / 219.69 | 196.05 / 225.25 | 199.74 / 217.23 |
| Startup style CPU, ms       |   45.21 / 59.49 |   45.98 / 70.48 |   47.91 / 77.05 |   47.79 / 60.42 |

Paired median gesture changes are −2.14% A/B and +8.39% A/A. Paired startup
task/script CPU changes are +1.14%/−2.26% A/B and −6.10%/+1.90% A/A.
One-minute host load ranged 15.18–41.02 (median 26.93).
The style subphase has +5.12% paired median and +18.5% raw p95; this is
disclosed rather than described as an all-subphase win. Overall task median
changes +4.99%, with a lower p95; script median improves and its p95 changes
+0.3%. No audio owner changed. Gesture-to-unlock readiness is inside the
acceptance band in this population; the earlier isolated play-duration
regression did not reproduce here. Its exact cause is not established. This
unlock probe does not establish remote-stream, acoustic, provider, codec, or
network latency.

## Reproduction

Use Node 26.12.1, `NODE_DISABLE_COMPILE_CACHE=1`, the pinned package installation,
and two complete production bundles from `pnpm ui:build` (base and candidate).
The stationary-tooltip acceptance command is:

```sh
pnpm exec tsx scripts/bench-control-ui-talk.ts \
  --bundle-dir "$BASE_BUNDLE" --compare-bundle-dir "$HEAD_BUNDLE" \
  --pairs 20 --duration-ms 3000 --viewport both --cpu-throttle 4 \
  --states listening,idle --focused-stop --aa --output "$PROOF_DIR"
```

Use separate one-pair runs with `--counters --first-pair-screenshots` for callback
counts and pictures, or with `--trace` for source/native attribution. The ordinary
state selection is `listening,speaking,responding,idle,hidden` at `--cpu-throttle 1,4`.
Hidden-caption calibration uses `--states hidden-transcribing --external-transcripts
--expect-hidden-parked`. Every recorded browser manifest says `headless: true`.

## Benchmark corrections for steady-state follow-up

The original measurements above used the `neutral-tooltips-v2` workload. Later
trace inspection found deferred service-worker asset downloads inside some
ordinary quiet-state windows: page `networkidle` does not observe worker
requests. The intermediate `network-settled-v3` workload keeps the service worker
enabled, waits for native worker readiness and 1.5 seconds of context-wide
network quiet, and rejects a measured window with an in-flight or newly started
asset GET. Its waiting timers end before CPU sampling. This corrects the
steady-state workload; it does not reclassify the earlier raw observations.

The optional `--startup-latency` probe records Start pointerdown through the
first native play readiness using the same browser-local clocks as the completed
external whole-gesture probe. Its CPU endpoints cover the larger Start sequence.
The retained external runner and fixture hashes establish source equivalence;
the original observation manifests remain unchanged.

Publication review: the first attempt ended without an assessment after HTTP
429 responses (`reviewer_unavailable`). After applying the benchmark corrections,
a fresh isolated review on the same route completed with no actionable P0–P2
findings; final source verification passed. The reviewer did not execute the code
or independently validate the performance measurements.

Before landing, repeat only the focused-tooltip cells with
`precache-settled-v4`: ten serial interleaved A/B and A/A pairs per desktop/mobile
viewport at 4×, three-second
listening/idle windows, with the Stop tooltip focused. Report that confirmation
separately from v2, and extend to twenty pairs if a cell remains borderline.
This resolves the discovered network-attribution gap without repeating unrelated
behavior tests or changing the earlier raw observations.

### Explicit precache completion (v4)

The first v3 canvas campaign stopped at its first contaminated window: 411
service-worker asset GETs began during desktop A/A pair 2's listening sample.
The failed run and all preceding rows remain retained; they are not the final
acceptance campaign. Network quiet can occur while the worker hashes and writes
cached assets, before the next deferred batch starts.

The v4 benchmark sends the existing version/precache probe with the browser's
real connection flags, waits for the worker's existing preparation promises via
its inspector, and verifies the offline shell and every boot/deferred inventory
URL in its current cache. This changes no production code or worker behavior.
It then waits for network quiet and retains the strict per-window GET rejection.
The canvas campaign restarts with the same predeclared sample counts and states;
the targeted tooltip confirmation also uses v4. No earlier timing table is
relabeled as v4 evidence.

### Hidden CPU attribution

All eight retained canvas diagnostic hidden traces contain no `MinorGC` or
`MajorGC` event, and no GC-related phase overlaps their measurement intervals.
Their sampled JavaScript profiles are over 99.7% idle. At 4×, about 2.3 seconds
of renderer-main thread CPU accrues between ordinary task slices in each
three-second window; audio-thread CPU remains about 40 ms. At 1×, renderer-main
CPU is about 37–50 ms. This is strong evidence consistent with CPU-emulation
overhead, although no named trace event identifies its exact mechanism. It is
not evidence of continuous Talk audio or JavaScript work. Later untraced windows
with heap drops are retained as unexplained spikes, not confirmed GC.

The first readiness-only review hit its 30-minute engine limit without an
assessment. A longer review on the same route completed with no actionable
P0–P2 findings and passed final source verification. The separate canvas source
review also completed cleanly. Neither review independently establishes
performance acceptance.

### Startup boundary correction

Source inspection identified the first native `play()` call as the short
gesture-unlock WAV in `GatewaySpeechPlayback.prepare()`. The preceding first-play
and whole-gesture tables measure that unlock promise, not remote Talk audio
readiness. The WebRTC stream starts through a later `srcObject` play call. These
old timings remain recorded, including their adverse tails, but cannot establish
unchanged remote-stream latency. A source-classified probe will retain both
boundaries separately before the canvas change is accepted.

The updated probe records every native play call's source kind and outcome,
without source URLs, and separates the remote-stream promise from the existing
all-playback readiness wait. It also records startup asset traffic and host load.
Default startup remains cold and precedes precache completion. An explicit
`--startup-warm-cache` mode measures a separate cache-settled population; it does
not relabel or replace cold observations. Steady-state CPU and network windows
retain the same v4 measurement boundaries.

### Complete v4 canvas comparison at 4×

The production canvas candidate at `2ddbaefcab1` is compared with its own merge
base `a3151e39a94`; it does not include the separate overlay candidate. Twenty
serial interleaved A/B and A/A pairs per viewport completed all 800 planned state
windows. Every window passed the zero-asset-download check, all 160 browser/cache
identities reconciled, and every hidden endpoint reported native hidden visibility.
The unchanged A/A controls remain separate; none are subtracted from A/B.

CPU entries below are task ms/s, median / nearest-rank p95. The change column is
the median of each matched pair's percentage change, rather than a ratio of the
two marginal medians.

| Viewport / state          |            Base |        Canvas | Paired change | A/A paired change |
| ------------------------- | --------------: | ------------: | ------------: | ----------------: |
| Desktop, speaking         |  96.20 / 106.06 | 42.95 / 54.56 |       −56.08% |            +2.29% |
| Mobile, speaking          | 105.20 / 118.57 | 44.93 / 52.52 |       −57.19% |            −0.65% |
| Desktop, responding / TTS |   77.16 / 89.14 | 47.02 / 54.29 |       −41.78% |            +0.82% |
| Mobile, responding / TTS  |   79.72 / 93.20 | 46.23 / 53.79 |       −41.49% |            +0.36% |
| Desktop, listening        |     1.26 / 1.86 |   1.30 / 1.62 |        +0.90% |            +3.19% |
| Mobile, listening         |     1.35 / 1.76 |   1.34 / 1.73 |        +2.71% |            +8.23% |
| Desktop, idle             |     1.46 / 2.05 |   1.56 / 2.05 |        −1.18% |            +9.48% |
| Mobile, idle              |    1.93 / 33.34 |  2.03 / 22.05 |       −10.31% |           +17.51% |
| Desktop, hidden           |    0.48 / 93.32 |  0.47 / 46.63 |       −10.03% |           −18.20% |
| Mobile, hidden            |    0.41 / 95.06 |  0.44 / 40.62 |        −6.90% |           +52.74% |

The canvas trades some JavaScript drawing for much less native frame/style work.
For example, desktop speaking script CPU is 3.00 → 5.87 ms/s and responding is
0.42 → 5.03 ms/s; overall task CPU falls by 53.24 and 30.14 ms/s respectively
when comparing marginal medians. The source-mapped diagnostic and removed style
updates establish the owner of that saving. This is a main-thread CPU win, not a
claim that JavaScript execution alone decreased.

Ordinary listening is already near the page-task floor and has no demonstrated
40% win. The canvas stops settled quiet/hidden painting. All 160 hidden rows have
zero analyser reads. This acceptance run disables callback instrumentation;
absence of timer/rAF counter values is not proof of zero callbacks. The separate
diagnostic supplies those counts. Large hidden spikes also occur in unchanged
A/A rows; their heap drops alone do not establish GC. Raw process CPU remains
separately bracketed and is not a battery estimate.

The cold first/unlock-play probe remains adverse: desktop ready median/p95 is
283.45/352.10 → 301.60/565.80 ms; mobile is 312.75/406.50 → 321.80/530.30 ms.
Startup task CPU paired medians rise 5.41% and 6.69%. These observations cannot
be discarded because the active-state win is large. The source-separated probe
is committed as `a5c58cd9f49`; remote-stream and unlock timing, followed by the
1× comparison, remain required before accepting the canvas change's latency.

### Final stationary-tooltip confirmation (v4)

Ten serial interleaved A/B and unchanged A/A pairs per viewport completed all
160 observations and 80 browser/precache identities. All three-second windows
passed the zero-asset-traffic check. Task CPU improved in every one of the 40
matched A/B state pairs. This run has no startup-latency instrumentation.

Values are task CPU ms/s, median / nearest-rank p95. Changes are medians of
matched-pair percentages. The A/A control is reported separately, never subtracted.

| Viewport / state with Stop tooltip |            Base |           Head | Paired change | A/A paired change |
| ---------------------------------- | --------------: | -------------: | ------------: | ----------------: |
| Desktop, listening                 | 31.127 / 36.781 |  2.499 / 9.113 |      −92.405% |           −6.703% |
| Desktop, idle                      | 30.800 / 47.209 |  1.513 / 2.585 |      −95.623% |          −12.061% |
| Mobile, listening                  | 29.747 / 32.950 | 4.417 / 10.201 |      −85.586% |           +0.255% |
| Mobile, idle                       | 26.110 / 33.350 |  2.224 / 3.113 |      −92.003% |           +5.580% |

Script CPU paired medians fall 91.2–92.2%; head medians range 0.486–0.568 ms/s.
The separate diagnostic establishes the removed recurring geometry rAF work;
this uninstrumented confirmation establishes its CPU effect. These are page-task
measurements, not audio latency or battery estimates. The unchanged A/A tails
are noisy, but every A/B pair improves and both candidate p95s fall substantially.

### PR typecheck correction

The first PR run exposed an HTML/SVG union test assignment to readonly
`className`, plus the narrower core-test ES2023 library declaration reached
through the new observer import. The test now uses `classList.add`. The existing
observer owner explicitly references `es2024.collection` for its existing
`Map.groupBy` calls, as other UI owners already do. Application behavior is
unchanged. The owner and browser-test files were also formatted with the pinned
formatter. Final owner/test LOC is 526/395, versus 314/306 at the merge base.
