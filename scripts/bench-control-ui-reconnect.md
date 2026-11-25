# Control UI reconnect benchmark

This runs built production Control UI bundles against the existing synthetic Gateway fixture. It measures the real renderer, Gateway browser client, reconnect supervisor and session owners; it does **not** measure a real Gateway, TCP reconnection, provider latency or an operating system wake.

Use immutable built directories. The runner reads each bundle's build identity and matches its mock hello. It never builds or changes bundles.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-reconnect.ts \
  --bundle-dir .artifacts/reconnect/base-bundle \
  --compare-bundle-dir dist/control-ui \
  --pairs 1 --first-pair-screenshots \
  --output .artifacts/reconnect/matrix-smoke
```

The default matrix has 16 cells per bundle: four scenarios × 0/100 ms RPC RTT × 1/10 panes. `--smoke` selects only the 5-second drop, 100 ms RTT and one pane. `--scenarios brief-drop,long-sleep`, `--rtt 100` and `--panes 10` narrow a run. Every cell uses 1,000 sessions; replacing the last inventory row with a new witness preserves that count. The shared interaction fixture also includes its model and automation catalogs.

| Scenario     | Loss and restoration                                                                                                                                                 | Measured endpoint                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brief-drop` | Transport rejects attempts for five real seconds. Browser `online` changes false/true and emits offline/online events.                                               | Fully live predicate below.                                                                                                                                            |
| `long-sleep` | Transport closes, document visibility changes to hidden, and `Date.now()` advances 30 minutes. Restoration changes visibility to visible; it does not emit `online`. | Fully live predicate below.                                                                                                                                            |
| `restart`    | Same build, new Gateway boot ID; transport becomes available without a browser online or visibility event.                                                           | Fully live predicate below.                                                                                                                                            |
| `update`     | Different build and boot IDs; transport becomes available without a browser event.                                                                                   | Visible **Server updated** action, `reconnecting` phase, retained draft and no post-restoration `chat.send` RPC. This is the update gate, **not fully live recovery**. |

Sleep is a synthetic clock/transport/visibility transition: performance clocks, timers and rendering remain native, and no real 30-minute wait or OS suspension occurs. Restart/update have no artificial downtime before restoration; the measured interval includes the supervisor's next permitted attempt. The 100 ms RPC profile splits delay between request and response delivery, including a half-RTT challenge delivery. Failed offline attempts close rather than waiting for the fixture's automatic `setOnline(true)` opener.

HTTP assets are local by default. Add `--asset-latency-ms 100` to delay each HTTP request, including worker modules and synthetic bootstrap responses. For complete local/remote comparisons, run `--rtt 0 --asset-latency-ms 0` and `--rtt 100 --asset-latency-ms 100` separately with identical bundles and pair counts. This models fixed request latency; it does not emulate bandwidth, packet loss or connection establishment.

The live endpoint requires connected state, fresh history text in **every** visible pane, a delivered post-restoration sidebar RPC, and a newly admitted sidebar witness visible in the default Created ordering. That witness has a new key and newest `createdAt`/`updatedAt`; an existing row rename cannot establish refreshed membership. The new hello must contain changed presence, all pane composers must be editable, and the first pane must retain its nonempty draft with its **Send message** button enabled and not busy. It does not send the draft. Ten panes use the supported persisted split layout, with ten equal vertical weights; the desktop layout renders all ten. The run asserts the actual mounted count.

Sidebar responses use the production shared-fact and row-revision packer, including conditional deltas when the client sends a matching receipt. Brief drops and sleep retain the fixture owner’s row history; Gateway restart/update recreates it to model lost in-memory revision identities. Row counts describe transmitted rows, not the size of the client’s reconstructed roster. The update case seeds the existing 30-second reload guard so this old-bundle fixture can capture the prompt and retained draft before automatic document recovery. Its composer and Send action remain available for the local offline queue; the non-connected phase fences remote dispatch. The probe leaves its draft unsent and asserts that no `chat.send` RPC escapes during restoration.

Add `--update-reload` to continue update samples through the real **Server updated** action and a new document. This optional mode creates caller-owned copies of each bundle below the output directory, then uses the existing production identity refresh helper and HTTP server build selector. Compiled assets stay identical; document, public asset, service-worker and offline-shell identities advance together. This is a synthetic same-code update, not a new release build. Use a fresh output directory; the runner does not replace earlier staged copies.

`wallMs` remains transport restoration to the update prompt. The additional `updateReload.wallMs` is the automatically clicked Refresh action to the same fully live predicate used by the other scenarios, measured with `performance.timeOrigin + performance.now()` across documents. Human decision time has no fixed bound and is excluded. The first document alone seeds the split layout; the new document must restore the existing layout and unsent draft without test re-entry. Persisted fixture history and the changed server identity survive reload; sidebar membership and presence are rechecked. The result retains pre-refresh and post-refresh RPC records separately and rejects any `chat.send`. New-document long tasks are recorded, while cross-document CPU counters are deliberately not claimed. HTTP delay follows `--asset-latency-ms` in both documents.

`--warm-picker` opens, searches and closes the active pane's model picker before the drop. After the measured reconnect interval it verifies the same retained menu node can reopen and search, with no session patch or message send. This checks an already opened, retained panel across reconnect. The node-retention assertion excludes `update`, which intentionally replaces the document; use a focused `--scenarios long-sleep --panes 1` comparison for retained-menu timing. The separate interaction scenarios `model-picker-first-open-search` and `model-picker-open-search` compare initial opening with the existing reopened-panel path on desktop/mobile; the first-open scenario also reports automation-to-focus `firstOpenReadyMs`.

For call counts during a picker interaction, run `scripts/bench-control-ui-interactions.ts --function-counts --steps model-picker-first-open-search` with the same bundle arguments. Coverage begins before navigation so already optimized functions cannot escape instrumentation, then resets immediately before the interaction. This diagnostic writes preparation and interval V8 precise function/block coverage to each sample's `functionCoveragePreparationArtifact` and `functionCoverageArtifact`; it does not produce timing summaries. An absent interval function is not an explicit zero without its preparation registry. Run it separately from `--trace` or `--selector-stats`, since coverage instrumentation changes execution cost.

To distinguish input delivery from automation waits, select `--steps model-picker-first-open-phases` with the interaction runner; `--resource-counts` does not select it automatically. This diagnostic records native trigger/search event timestamps alongside the existing `firstOpenReadyMs` in `scenarioEvidence`. It preserves the original action cadence and retrieves the event records only after the original assertions finish. Event timestamps and listener-observed times share the recorded browser performance clock; they identify phase gaps and are not normal timing evidence. Its owned listeners are removed after the action, including failures.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-reconnect.ts \
  --bundle-dir .artifacts/reconnect/base-bundle \
  --compare-bundle-dir dist/control-ui \
  --scenarios update --update-reload --pairs 1 \
  --first-pair-screenshots --output .artifacts/reconnect/update-reload
```

For timing claims, use at least ten serial interleaved pairs on the same host:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-reconnect.ts \
  --bundle-dir .artifacts/reconnect/base-bundle \
  --compare-bundle-dir dist/control-ui \
  --pairs 10 --thread-cpu-time --aa-control \
  --output .artifacts/reconnect/paired
```

Pair order alternates. `--aa-control` adds an independent base-bundle run in each cell, producing base/control/head triplets. On a noisy host, use 20 pairs and judge CPU and work counts when A/A wall timings are outside the acceptance band. A clean timing cell has median regression ≤5% and no worse p95, or another ten pairs confirms that band. The performance target is 40% faster brief-drop/sleep recovery and no reconnect long task over 100 ms; a missed target does not invalidate a clean measured win. A regression over 20% still blocks.

`results.json` preserves samples, failures and median/p95/min/max by cell. It records host load, RPC methods, response bytes, delivered session-row/history-message counts, and CDP script/task/layout/style durations. `--thread-cpu-time` selects CDP thread ticks; otherwise those durations include descheduling. Wall time is restoration mark to readiness assertion, not INP. The Long Tasks observer records tasks of at least 50 ms and drains pending records after readiness. It includes any task overlapping the restoration/readiness interval, retaining its full duration so synchronous restoration in the marking task cannot be omitted; a zero maximum means none observed. Work continuing after readiness is outside the interval and unfinished RPCs remain identified.

Use a separate `--trace` run for attribution: it saves raw trace JSON, CPU profiles and summaries between the restoration/readiness marks. Its overhead is included. With `--update-reload`, the CPU profile stops before navigation, which resets Chrome's profiler; the timeline can include the subsequent reload, but its summary remains bounded by the original restoration/readiness marks. `--first-pair-screenshots` captures each initial cell; failures always retain screenshots, HTML, stage, exact list queries/membership and browser diagnostics. All fixtures are synthetic. Treat failed setup/assertions as a benchmark failure, not a product timing sample. Browser contexts, the owned browser and HTTP servers close on normal completion or handled failures.
