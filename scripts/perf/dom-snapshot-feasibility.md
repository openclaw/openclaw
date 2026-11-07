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
Team uses two balanced six-pair blocks with `--paint-holding --runs 12`
(its maximum is twenty), and active/archive flags from the L300 report. All five
workloads use the same built source.

The replay uses an inert, aria-hidden, closed shadow overlay with an empty scoped
custom-element registry, excluding scripts, inline handlers, script URLs and
embedded browsing contexts. Its stylesheet URLs match the old page. The closed
root prevents rig/app selectors from mistaking replay nodes for live ones. Scroll
positions and input values are carried separately. The overlay is removed in the
animation frame after live rows and populated Details report Element Timing.
Inspect native PNGs around snapshot paint and swap; marker times alone are not
visible-state or pixel-parity evidence. No screenshot/HTML upload is part of this
experiment. A product implementation requires separate storage approval.

For a separate pixel-attribution pass, set `L303_HOLD=1` and use only two reloads.
The rig captures a synthetic snapshot PNG after the live complete marker, removes
the overlay, and captures the app PNG and region boxes. This adds screenshot work
and holds the overlay: exclude this mode from all timing comparisons. Timed mode
has neither capture nor visual witness. Held mode adds a two-pixel magenta
viewport border following overlay visibility; mask it in pixel comparisons. Its compositor
pixels distinguish the new-document snapshot from an identical held old page.
Required Details/board surfaces come from the captured old
page, so a late mounting surface cannot be mistaken for a closed one. Image
metadata records completion and intrinsic size in the first replay animation
frame; actual image paint and font parity still require inspecting compositor
pixels. Raw/gzip app markup and the full injection envelope are reported apart.

Font-face declarations must register in the document: shadow-root declarations
do not make a document font available in the Chromium control. The replay
registers the captured rules early, loads the old page's used fonts, and restores
scroll after stylesheet/font readiness. Fallback-font pilots are setup evidence,
not complete-snapshot timing comparisons.

The held pixel-attribution mode also records CDP image cache/worker flags for
that new main document. This Network observer is disabled in timing mode and
does not alter either serialized browser function. Cache flags describe those
requests, while compositor pixels decide whether an image was present at first
paint. The native custom-root fixture revalidates assets; do not infer bundled
asset-cache behavior from its HTTP status alone.

For Team timing repetitions, `L303_TIMING_ONLY=1` limits post-capture pixel
classification to the first and last frames. All compositor frames and Element
Timing entries are still captured. The report explicitly records endpoint
sampling; its state counts are not a visual-state census. Leave this unset for
the separate full visual audit. Both A/B and A/A use the same setting and cadence.
