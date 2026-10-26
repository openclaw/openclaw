# Plugin view performance

Run the production renderer against immutable assets produced by the official
plugin builder. Each plugin root contains `<plugin>/dist/openclaw.plugin.json`
and its declared `dist/control-ui/<generation>/` directory. The host build must
contain the packaged Memory Core, Nostr and WhatsApp settings declarations.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-plugin-views.ts \
  --bundle-dir dist/control-ui \
  --plugin-root .artifacts/plugin-views/base \
  --compare-plugin-root .artifacts/plugin-views/head \
  --pairs 10 --profiles local,remote --thread-cpu-time \
  --output .artifacts/plugin-views/comparison
```

Use the same base root for both arguments for an A/A control. Collect `--pairs 1
--coverage --loads-only` and `--pairs 1 --trace` in separate output directories for
coverage and attribution; instrumentation overhead makes those timings unsuitable
for untraced comparison. `--plugins` accepts a comma-separated subset of
`workboard,memory-core,nostr,x,clawrouter,whatsapp,knowledge,mcp-relay`. Its default
remains the original three plugins. `--build-host`
explicitly builds the host with `startProductionControlUiE2eServer`; by default the
script serves an existing production build and never builds plugins.
For an interrupted campaign, preserve its output and start a separate directory
with `--pair-offset N`, where N complete pairs already finished. This preserves
logical pair IDs and alternating AB/BA order; retain both runs' provenance.

Use `--loads-only` for a focused load-only comparison. Workboard load readiness
requires every column's full logical count, enabled creation, and a menu trigger
for every mounted card; cached read-only rows alone do not end the interval.
By default every logical card must also be mounted. For a windowed candidate use
`--windowed-variants 1` (zero-based root indexes; use `0,1` for a windowed A/A
control). Those variants must mount between one and 24 cards in each column with
more than 24 logical cards, and must expose the active window marker. Smaller
columns still require every card. The driver never silently accepts fewer cards
in an unwindowed baseline. Trace runs also collect a post-GC heap/DOM
sample after profiling and all measured actions finish; this is retained-view
evidence, not a leak test.

The workload defaults to a 300-card, six-status Workboard. `--columns 9` exercises
all nine statuses allowed by the public Workboard contract; there is no valid
20-column topology. Cover both 300/6 and 300/9 when checking windowing behavior;
choose and report the timed topologies separately. The other
plugins retain the supported default 20-result Memory search and the Nostr
settings/profile editor. Nostr has no feed renderer.
Workboard covers search, clearing search, selecting, scrolling, opening a card,
closing the card, dragging to another column, and a live update. Memory covers search, expansion and
scrolling. Every meaningful state change has a visible assertion; drag waits for
the move RPC and the card rendered in its destination within the timed interval.
The move targets the gap after the destination's first card and checks the
acknowledged position between its first two cards (small fixtures with an empty
destination retain the existing whole-column drop). After measured interactions,
large columns also prove that middle and bottom cards are reachable by scrolling,
Tab and Shift-Tab preserve logical neighbors across a rendered-window edge, and
closing a detail dialog returns focus to the exact card after its scrollport is
moved offscreen while the board is inert. These untimed checks are recorded in
`windowChecks`; they do not replace the individual timed interaction assertions.
The plugin unit regression separately covers a logical drop successor absent
from the DOM. Element, comment, slot and heavy-card counts are recorded alongside
the CDP total-node count so lightweight windowing owners remain visible in the
memory comparison.

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

## Remaining plugin surfaces

Collect a report-only baseline with one immutable plugin root and ten samples per
plugin/profile before comparing a candidate. Omitting `--compare-plugin-root`
uses one variant, so `--pairs 10` means ten samples for each plugin and profile.
Start with one sample to prove collection and behavior, retaining failures, before
releasing the full baseline. Run all browser measurements serially.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-plugin-views.ts \
  --bundle-dir .artifacts/plugin-views/host \
  --plugin-root .artifacts/plugin-views/baseline \
  --plugins x,clawrouter,whatsapp,knowledge,mcp-relay \
  --items 300 --pairs 10 --profiles local,remote --thread-cpu-time \
  --output .artifacts/plugin-views/remaining-baseline
```

| Plugin     | Production entry path and fixture                                                                                                                                                           | Measured actions and readiness                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X          | `/plugin?plugin=x&id=replies`; two accounts, `--items` manual rows and half as many GitHub-derived rows per account                                                                         | Exact row counts, primary account and enabled Refresh; typing, same-value refresh, add/remove, guest toggle, account switch and scroll. The first row must retain identity after add. There is no feed/search UI. |
| ClawRouter | `/plugin?plugin=clawrouter&id=pool`; 20 grants × 20 models, four quota windows each, 20 lane traffic rows and 380 correctly keyed grant traffic rows                                        | 20 grants, 80 windows, 400 model rows and 20 lanes, with settled busy state; same-value refresh, changed refresh and scroll. No drag/filter UI exists.                                                            |
| WhatsApp   | Packaged settings-only renderer inside `/settings/channels`; seven facts, eight with a phone number                                                                                         | Native channel detail and enabled Show QR; same-value refresh, local synthetic QR, host-owned login completion, phone insertion/removal. No external account or provider is contacted.                            |
| Knowledge  | `/plugin?plugin=knowledge&id=overview`; one ready isolated store, 20 recent items, one source with 60 claims in three bounded pages, 50 browse rows from `--items` pages, 20 search results | Exact loaded counts; source collapse/expand, source pagination/scroll, browse/claims, suggestions after the existing 200 ms debounce, search, record/markdown continuation and live offer/application.            |
| MCP Relay  | `/plugin?plugin=mcp-relay&id=connected-apps`; `--items` grants belonging to a synthetic administrator                                                                                       | Exact grant count and enabled pairing; 20 unrelated public chat-metadata events, refresh, pair dialog/code, revoke and consent presentation. Consent decisions and external navigation are excluded.              |

`--items` defaults to 300 and accepts 50–1000. Each individual Knowledge response
stays bounded; accumulated source claims grow only after explicit pagination.
Knowledge's separately registered session-activity panel opens through the chat
header's native Panels control. It covers 40 initial rows, 40 older rows, ordering,
read filtering and a 5000-character preview. Chat navigation happens outside that
panel's measured interval and has no navigation-performance claim. These fixtures do not claim real Gateway,
relay, social-network, provider or account latency.
WhatsApp uses a 1 × 1 synthetic PNG to measure QR state rendering, so its results
do not represent the image-decoding cost of a realistic QR code.

X and ClawRouter module activation precedes their page mount; cold coverage starts
before navigation so it includes that work. WhatsApp loads through the real
settings placement, not a synthetic standalone page. The warm route leaves each
surface completely before remounting it. Packaged and dynamic plugin assets both
retain their official built bytes, revision and digest.

MCP Relay `pluginObservations.hostPublications` records child-list mutation counts,
added/removed nodes, first-row identity and focused-button identity during unrelated
host updates. Baseline identity/focus loss is an observation, not an assertion
that prevents measuring the current implementation. X's keyed-row retention is
an existing correctness contract and remains asserted. Other scalar facts in
`pluginObservations` describe the completed workload, not performance thresholds.
Each MCP host event waits for synthetic WebSocket delivery and a rendered frame,
including the 100 ms delivery delay in the remote profile.
Knowledge request counters also break down the `plugins.sessionAction` total by
plugin and action ID; those keys are subdivisions, not additional transport calls.

For the WhatsApp catalog split, add `--plugins whatsapp --whatsapp-locale-proof`
to a one-sample diagnostic. It starts in English, changes the public config locale
to German, English and Swedish while retaining the mounted fact rows, QR image
and scan control, and asserts one translated-catalog request across those changes.
It then reloads into a new German document (HTTP cache remains disabled) and
aborts only the plugin catalog on a final reload to prove usable English fallback.
The German reload measures new-document readiness, not a fresh browser process.
This opt-in proof is separate from the normal English timing workload.

Compare task/script/style/layout CPU, long tasks, heap, node counts and loaded/
unused bytes alongside automation-to-assertion wall time. The latter is not INP.
Use at least ten pairs for timing claims; on a noisy host add an A/A control and
twenty CPU pairs. A clean cell has median regression at most 5% and no worse p95;
a >20% attributable regression blocks. Report incomplete scenarios as failures,
never as a performance improvement.

## Repeated view lifetime

Use `--plugins workboard,mcp-relay --leak-rounds 5 --pairs 1` separately from
timing, coverage and trace runs. Each round opens the view, verifies 50 updates,
then navigates away in the same document. Workboard receives a changed card
snapshot on each event. MCP Relay refreshes a changed grant and receives an
unrelated host publication on each cycle. Both paths assert their visible result.
The normal cold and warm setup precedes the closed baseline.

Each closed sample records heap after two explicit GCs, DOM nodes, documents,
and event listeners. Baseline/final raw heap snapshots and native detached-node
summaries live beside the incremental `leak-check.json`. These include the host
and synthetic transport: inspect retainers and request-history growth before
attributing an increase to the plugin. Stable endpoint counts alone do not prove
leak freedom. The command reports measurements without declaring a leak verdict.

After the primary MCP closed snapshots, the probe focuses the host composer and
records separate post-focus counters. Those diagnostics never replace the raw
closed-view samples; they help attribute retention by native event machinery.
