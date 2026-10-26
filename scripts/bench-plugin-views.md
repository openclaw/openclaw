# Plugin view performance

Run the production renderer against immutable assets produced by the official
plugin builder. Each plugin root contains `<plugin>/dist/openclaw.plugin.json`
and its declared `dist/control-ui/<generation>/` directory. The host build must
contain the packaged Memory Core and Nostr settings declarations.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-plugin-views.ts \
  --bundle-dir dist/control-ui \
  --plugin-root .artifacts/plugin-views/base \
  --compare-plugin-root .artifacts/plugin-views/head \
  --pairs 10 --profiles local,remote --thread-cpu-time \
  --output .artifacts/plugin-views/comparison
```

Use the same base root for both arguments for an A/A control. Use `--pairs 1
--coverage --trace` in a separate output directory for attribution; instrumentation
overhead makes those timings unsuitable for untraced comparison. `--plugins`
accepts a comma-separated subset of `workboard,memory-core,nostr`. `--build-host`
explicitly builds the host with `startProductionControlUiE2eServer`; by default the
script serves an existing production build and never builds plugins.
For an interrupted campaign, preserve its output and start a separate directory
with `--pair-offset N`, where N complete pairs already finished. This preserves
logical pair IDs and alternating AB/BA order; retain both runs' provenance.

Use `--loads-only` for a focused load-only comparison. Workboard load readiness
requires all cards, enabled creation, and every card menu trigger; cached read-only
rows alone do not end the interval. Trace runs also collect a post-GC heap/DOM
sample after profiling and all measured actions finish; this is retained-view
evidence, not a leak test.

The workload uses a 300-card, six-status Workboard, the supported default 20-result
Memory search, and the Nostr settings/profile editor. Nostr has no feed renderer.
Workboard covers search, clearing search, selecting, scrolling, opening a card,
dragging to another column, and a live update. Memory covers search, expansion and
scrolling. Every meaningful state change has a visible assertion; drag waits for
the move RPC and the card rendered in its destination within the timed interval.

Each sample creates fresh Workboard data with an initial update age of 2 days and
3 hours and an older creation time. Cold and warm readiness assert the existing
renderer’s `2d ago` text: the owner rounds day-aged cards to whole days before
formatting. This consistently exercises the non-recent formatter path with native
clocks, instead of crossing out of “just now” as a shared process fixture ages.
`samples.json` records fixture generation, creation and update timestamps, initial
age, expected text, and observation times after cold and warm load. The live update
intentionally advances the changed card to a recent timestamp. Earlier runs made
with process-wide fresh timestamps retain their evidence but do not establish a
comparison on this stable age workload.

Add `--plugins workboard --linked-dependencies --cards 300` for the dependency
workload. It keeps 300 cards: 30 roots and 270 children with two distinct parents
each, 540 parent links plus their reciprocal child links, and at most 18 links per
card. Child readiness follows parent completion, checked before timing; the six
columns contain 275/5/5/5/5/5 cards at 300 cards.
The last root is Done, including at other supported card counts, so its child with
root zero has one blocked parent. The detail action opens a dependent card and
asserts both parents. The live action finishes root zero and asserts that this
child's warning clears; afterward an untimed check confirms its DOM node survived
the refresh (card objects are normalized anew). At 300 cards this is `bench-59`.
The live payload preserves the acknowledged drag's status/position before the
parent completion, advances its timestamp, and recomputes board counts. Summary
metadata records the linked option and root/child/link counts. Keep partial-page
completeness in the focused correctness test, separate from this full-board timing
workload. Without the option, the original unlinked fixture remains available.

Cold load starts with a new browser context. After that interval, the harness
waits on the plugin route for the host's naturally admitted New Session prefetch
assets: observed link completion, or a completed resource when the owner already
loaded it. Waiting before navigation avoids racing the owner's deliberate removal
of the current route from pending prefetch. Descriptor responses are observed
without refetching. Warm load remounts the plugin route in the same document with
resident modules, after New Session's committed composer and admitted lazy pet
renderer finish loading.
Playwright routing disables
HTTP cache, so warm load is not described as an HTTP-cache hit.

The remote profile adds 100 ms per HTTP request and per synthetic WebSocket
delivery. Results measure renderer/mock performance, not real Gateway latency.
AB/BA order alternates between serial pairs; `samples.json` retains every attempt,
including failures and host load. `summary.json` includes distributions, plugin
asset hashes/bytes, fixture counts, and instrumentation. Distributions include
only pairs where every requested variant completed successfully. `comparisonPairs`
records every planned pair's inclusion and failed/missing variants; failures remain
in `samples.json` and make the command fail. Screenshots cover the
first pair and failures. Trace runs retain renderer traces, CPU profiles and
source-mapping coverage (unmapped production assets are reported explicitly).
The untimed final Workboard check reopens the updated card's menu and verifies
Escape returns focus to its current trigger. Timed first activation uses the
second visible card, including shared-panel rebinding without preopening it.
Coverage runs record cold navigation and warm route remount separately; warm
coverage counts resident scripts observed by V8, not new network bytes.

Compare task/script/style/layout CPU, long tasks, heap, node counts and loaded/
unused bytes alongside automation-to-assertion wall time. The latter is not INP.
Use at least ten pairs for timing claims; on a noisy host add an A/A control and
twenty CPU pairs. A clean cell has median regression at most 5% and no worse p95;
a >20% attributable regression blocks. Report incomplete scenarios as failures,
never as a performance improvement.
