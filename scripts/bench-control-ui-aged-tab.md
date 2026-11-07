# Aged Control UI interaction census

This opt-in benchmark keeps one production tab and one idle tab alive while the
existing working-day driver exercises 200 sessions, 50 streamed turns, all of its
workspace/Settings routes, and ten reconnects. Two newly loaded controls at
each checkpoint each use a separate browser process, with the same fixture,
viewport and warmed controls. The measured 400-message conversations never receive the soak turns.
The sidebar inventory contains those two probes plus 200 soak sessions.

```sh
NODE_DISABLE_COMPILE_CACHE=1 pnpm ui:build
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-aged-tab.ts --samples 20 --rounds 10 \
  --idle-minutes 120 --output .artifacts/aged-tab/production
```

All browsers are headless. Chromium's idle tab is natively minimized and its
hidden visibility is asserted; WebKit's idle tab remains visible. The idle
clock starts after warming the five actions. Its first post-idle typing sample
is recorded before preparation or warm-up; subsequent samples measure sustained
responsiveness. Fresh controls are reloaded at each checkpoint, but repeated
samples within that checkpoint intentionally retain their documents.
Each Chat measurement restores the same three retained session keys in every
arm; matching only the pane count does not match the retained content.

Checkpoints cover the initial state, round 1, the middle/final round, and the end
of the idle interval. Each action rotates fresh, fresh-control and aged positions,
including reverse order. Actions reuse the interaction harness's native typing,
session switch, Settings route switch, sidebar toggle and model-picker recipes.
Preparation is outside the measured interval. Input-to-last-observed-commit is
application elapsed time, not paint time or CPU; driver and assertion tails stay
in the raw records. Compound actions include gaps between their native inputs.
Typing's draft and no-send assertions run after measurement. Its request-count
checks return a scalar instead of serializing the aged fixture's retained log.
Putting those checks inside a CPU window measures growing benchmark history.
Preparation uses the existing Scroll to latest control when a retained pane
restores an older position. Service workers are excluded, as in the shared
engine harness; the native idle context receives an unavailable worker script.

`observations.json` contains every action, input/commit boundary and host load.
`checkpoints.json` records document identity/age, active resources, cumulative
callback counts, retained pane hosts, DOM size, stylesheet/rule counts and fixed
computed styles. Do not treat cumulative creations or callback totals as leaks.
Screenshots use synthetic content only. The manifest pins source/build identity
and the measurement contract.

For attribution, run a separate `--trace` pass. Chromium reports thread CPU and
style/layout counts; WebKit uses Inspector Timeline application work, never its
smoothed CPU utilization as action CPU. `--heap` adds post-timing forced-GC
snapshots, retained Solid owner/cache counts on Chromium, and engine memory/DOM
counts. It deletes the large snapshots after extracting their summaries. Keep
this diagnostic pass separate: forced GC and observation perturb aging.

Compare each aged/fresh ratio with the initial aged/fresh ratio, and compare the
fresh-control/fresh A/A drift over the same checkpoints. Investigate degradation
above 10% beyond control, especially when a growing active resource or repeated
work count corroborates it. Noisy A/A timings require a separate CPU pass before
attributing a regression. This is renderer evidence with synthetic transport;
it makes no claim about Gateway/provider latency or actual full-day user traffic.

Use `--in-page` in a separate run to execute the same application actions inside
the document without driver calls between input and settlement. Records expose
synchronous dispatch, second-frame, and ready-state settlement times for each
phase. Typing delivers one synthetic input per two frames; picker search sets
the full query once. These are application-work controls, not interchangeable
with the native action spans. They do not exercise trusted keyboard defaults,
IME, pointer hit testing or native focus navigation. The idle wake probe remains
native in either mode.

Use `--soak sessions`, `turns`, `routes`, `reconnects` or `overlays` to isolate a
churn category. The default `all` retains the working-day workload. Every mode
still shares measurement preparation and parks on New Session after each round.
The turns mode reuses one conversation; route-only navigation is paced outside
measurement to stay below WebKit's history-write rate limit. Compare native and
in-page results before assigning compound input gaps to application work.

`--soak sessions-in-page` performs each round's 20 session switches within one
page evaluation, including route and transcript readiness. Checkpoint collection
and parking on New Session still use the driver between rounds. This isolates
per-switch driver traffic while preserving the application's navigation owner;
it does not disconnect the inspector or remove the synthetic transport.

Use `--match-sidebar` for a separate comparison with the sidebar's presentation
history removed. The normal run preserves its bounded prior-page retention;
a fresh document can show 15 rows while a used document shows 29. This option
uses Show more followed by Collapse to lower the page limit and clear that
membership history before Chat actions. Collapse alone at the default limit
does not clear it. The checkpoint records the census before this preparation,
and records exact sidebar row and retained pane keys so the compared workloads
can be checked. This is a diagnostic intervention, not the ordinary aged state.

Use `--match-styles` in a separate diagnostic run to load the aged tab's external
stylesheets in each fresh control before sampling. Route CSS remains resident
after its first visit; comparing a 77-sheet used document with a 20-sheet fresh
one mixes that bounded residency cost with progressive aging. The normal run
retains that user-visible cost. Compare both runs and keep their claims separate.
The census records stylesheet hrefs as well as counts. Fixture assertions stay
outside timing; retained mock request history is not application state.

For a candidate fix, `scripts/bench-control-ui-aged-tab-compare.ts --base-bundle
<base> --head-bundle <head> --native-census --output <directory>` runs twenty
rotated A/B/C samples at fresh and aged checkpoints. A and B use the same base
bundle in independent processes; C uses the candidate. Each document visits
200 sessions through the shared in-page soak before the aged samples. All five
actions use matched pane and sidebar contents. Compare the initial-normalized
C/A and C/B ratios with A/B; retain both application median/p95 and Chromium
thread CPU. WebKit has application timings, not untraced CPU measurements.
Native shimmer counts run after timing, because Inspector enumeration can
retain wrappers and normal DOM animation queries omit detached targets.
