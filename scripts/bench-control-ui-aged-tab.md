# Aged Control UI interaction census

This opt-in benchmark keeps one production tab and one idle tab alive while the
existing working-day driver exercises 200 sessions, 50 streamed turns, all of its
workspace/Settings routes, and ten reconnects. Two newly loaded control tabs at
each checkpoint use the same browser process, fixture, viewport and warmed
controls. The measured 400-message conversations never receive the soak turns.
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

Checkpoints cover the initial state, round 1, the middle/final round, and the end
of the idle interval. Each action rotates fresh, fresh-control and aged positions,
including reverse order. Actions reuse the interaction harness's native typing,
session switch, Settings route switch, sidebar toggle and model-picker recipes.
Preparation is outside the measured interval. Input-to-last-observed-commit is
application elapsed time, not paint time or CPU; driver and assertion tails stay
in the raw records. Compound actions include gaps between their native inputs.
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
