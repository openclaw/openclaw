# DOM snapshot feasibility (L303)

Rig-only acceptance: the first new-document complete snapshot must paint within
approximately 200 ms on real old-app reloads, with no exposed skeleton and a
bounded, explained swap difference. The unmodified application's rows and Details
must not regress under the campaign's order-adjusted comparison rule. Run twelve
interleaved AB/BA pairs and identical-build A/A on the same quiet c7a.4xlarge.
Record arm median/IQR, every pair delta, each order's median/IQR, raw paired median,
order-balanced estimate, and A/A-adjusted effect within each order.

The preload wraps only rig-owned Playwright browsers. It takes the old app's
settled DOM before measured navigation and supplies it through a CDP new-document
script. No rendered HTML is written to a client store or committed. Metadata and
synthetic compositor captures remain under `.local/`.

Use with L300 tooling at `3257c0d02ff644a7c8e06e33211e9a40f751234e`
(or its landed successor). Prefix the existing native proof or Team-scale bench:

```sh
L303_OUTPUT=.local/l303/native-archived \
node --import ./scripts/tsx.mjs \
  --import ./scripts/perf/dom-snapshot-feasibility-preload.ts \
  scripts/perf/warm-reload-proof.ts \
  --dist dist --ui-root dist/control-ui --transcript-late-paint \
  --details-session-facts --capture-ms 2500 --rtt-ms 80 --reloads 24
```

Each qualifying screencast-armed warm navigation follows AB/BA order: no overlay,
overlay, overlay, no overlay. Set `L303_AA=1` for the same instrumentation with no
replay in either arm. Native active adds `--active-targets
--details-subagent-activity --route chat`; archived covers chat and dashboard.
Team uses the existing bench with `--paint-holding --runs 24`, and active/archive
flags from the L300 report. All five workloads use the same built source.

The replay uses an inert, aria-hidden, closed shadow overlay with an empty scoped
custom-element registry, excluding scripts, inline handlers, script URLs and
embedded browsing contexts. Its stylesheet URLs match the old page. The closed
root prevents rig/app selectors from mistaking replay nodes for live ones. Scroll
positions and input values are carried separately. The overlay is removed in the
animation frame after live rows and populated Details report Element Timing.
Inspect native PNGs around snapshot paint and swap; marker times alone are not
visible-state or pixel-parity evidence. No screenshot/HTML upload is part of this
experiment. A product implementation requires separate storage approval.
