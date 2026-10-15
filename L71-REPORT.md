# Control UI shell style/layout cost: no production patch

## What Problem This Solves

Measure the browser rendering cost of a signed-in reload of a dashboard deep link. The original campaign recorded 14 visual states over roughly 15 seconds; later work removed the network waterfall and exposed client rendering cost. This experiment uses only the maintained synthetic Team-scale fixture.

## User Impact

**Do not promote these candidates.** Containment did not reduce layout work. Splitting the overlay reset selectors reduced style recalculation by 14.5%, but did not meet the required CLS-at-or-below-baseline gate. The selector source patch was reviewed through P2 and reverted. Runtime production LOC delta is **0**; there is nothing to land.

## Why This Change Was Made

The remaining cost is not simply the first transcript layout. Global overlay reset selectors repeatedly traverse nonoverlay ancestors across the shell. A faster style pass also exposes an existing padded-shell-to-workbench handoff in more measured frames. Stabilize that handoff before reconsidering the selector optimization. It is not a measured end-to-end win under the campaign's constraints.

## Evidence

### Setup and scope

Runtime source: `6e1bc0b2fffd2319bcb4b11e39550224923984a2`; production build identity: `dda7b582fe935ea1082c9208421cc3fc1a4e7358` (the initial report-only commit). One dedicated AWS Crabbox `c7a.4xlarge`, lease `cbx_0c1f2a6dfbf2`: observed 16 AMD EPYC 9R14 CPUs and 30.64 GiB RAM, Node 24.19.0, repository Playwright headless Chromium 153. Initial post-install load average was 3.85/2.21/0.89 on 16 vCPUs; no other workload was run during comparison.

The maintained `scripts/bench-control-ui-cold-load.ts` supplies the production server, mock Gateway, assertions, warmup, and measured reload. A local experiment copy separates tracing from timing and records native CDP Performance counters, CLS, paints, row attachment/reveal, and both campaign LoAF/mutation and WS census probes. Viewport: 1719 × 1179. Simulated reply latency: 35 ms; frame gap: 4 ms. Each invocation warms the signed-in dashboard, retains last-visit browser state, then measures one reload in a fresh browser/context. This is a cached-transcript scenario, unlike L68's explicitly uncached transcript experiment; those geometry timings are not directly comparable.

The fixture contains 300 sessions, a 200-row server page, 30 pins, 34 owners, 120 people, six agents/plugins, 240 transcript messages, and 12 inline widgets. At the final diagnostic, the main document had 2,696 light-DOM nodes, ten sidebar session rows, and ten virtual transcript rows. The large fixture does not imply that 300 sidebar rows are mounted simultaneously.

All performance comparisons ran on that same instance and fixed type. Seven interleaved blocks compared baseline/sidebar/rows/sidebarAuto, reversing order on alternating blocks. A separate seven-pair AB/BA comparison tested the selector rewrite. There were 42 untraced comparison captures, eight traced diagnostic captures, and two final untraced phase/shift-source diagnostics: **52 successful measured reload captures**, with no excluded samples. Each capture had its own preceding warmup.

Native Performance counters were enabled immediately before measured reload; no CPU profiler or trace ran in comparison samples. LoAF/mutation and mock-delivery probes remain instrumentation overhead shared by both variants. Traces use `toplevel,loading,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking`; selector captures additionally enable `disabled-by-default-blink.debug`. Selector statistics add substantial overhead and are used for attribution, never critical-path timing ([Chrome guidance](https://developer.chrome.com/docs/devtools/performance/selector-stats)).

All tables below use median (IQR), with linearly interpolated 25th/75th percentiles. Milliseconds except CLS. None of the reported timings were measured on the Mac.

### Containment comparison

The candidates were CSS response overrides on one immutable production bundle:

- `sidebar`: `contain: layout style` on the sidebar body and session rows.
- `rows`: `contain: layout style` on transcript rows and `contain: size layout style` on their extent.
- `sidebarAuto`: `content-visibility: auto; contain-intrinsic-size: auto 44px` on sidebar session rows.

| Mode        |     Style ms |  Layout ms |       FCP ms | Row reveal ms |               CLS |
| ----------- | -----------: | ---------: | -----------: | ------------: | ----------------: |
| baseline    |  543.0 (5.7) | 41.5 (1.5) | 464.0 (36.0) |  411.7 (31.2) | 0.00143 (0.00033) |
| rows        | 546.6 (35.0) | 41.4 (2.7) | 440.0 (18.0) |  389.9 (21.8) | 0.00175 (0.00469) |
| sidebar     | 529.9 (13.8) | 41.4 (1.1) | 440.0 (16.0) |  388.7 (17.9) | 0.00175 (0.00016) |
| sidebarAuto | 546.2 (21.2) | 42.2 (1.7) | 440.0 (12.0) |   389.3 (7.1) | 0.00702 (0.00000) |

Layout remains approximately 41–42 ms. The transcript already uses `content-visibility: auto` on virtual rows and `contain: size layout` on the extent; adding containment did not bypass a missing isolation boundary. Sidebar offscreen rendering adds a distinct approximately 0.00527 shift and fails the CLS gate. Settled synthetic screenshots were inspected; no layout benefit justifies these candidates.

### Overlay-selector comparison

The prototype rewrites descendant selectors such as `:is(.oc-overlay, .oc-modal-dialog) *` into `.oc-overlay *, .oc-modal-dialog *`, including the equivalent scrollbar descendant selectors. It preserves matching sets, specificity, and declarations. It changes served CSS only; inline stylesheet strings inside JavaScript were unchanged. A source equivalent in `ui/src/components/solid/overlay.css` was reviewed, but no full source-candidate bundle or shipping validation is claimed because the prototype failed the CLS gate.

| Mode      |     Style ms |  Layout ms |       FCP ms | Row reveal ms |               CLS |
| --------- | -----------: | ---------: | -----------: | ------------: | ----------------: |
| baseline  | 506.6 (17.3) | 39.8 (1.4) | 472.0 (22.0) |  420.3 (17.8) | 0.00143 (0.00493) |
| selectors | 433.0 (38.1) | 40.8 (2.7) | 448.0 (22.0) |  387.0 (20.0) | 0.01096 (0.00970) |

Style recalculation: **506.6 → 433.0 ms, −73.6 ms / −14.5%**. First row attachment: **363.8 (15.3) → 333.3 (18.5) ms**. Renderer task time: **2746.0 (126.8) → 2656.9 (237.9) ms**. LoAF blocking: **542.0 (31.5) → 514.0 (82.5) ms**. Every mode still sends **87 RPCs (IQR 0)**.

CLS is bimodal. Baseline values are approximately 0.0014–0.0018 in five runs and 0.0110–0.0113 in two; the selector candidate has three low and four high runs. The small sample and overlapping distributions do not establish the probability or unique cause of the shift. They also do not establish the required CLS safety; the candidate is rejected under that gate, rather than selecting only favorable runs.

### Selector attribution

These are overhead-heavy diagnostic measurements, not reload timing results. The two negative overlay selectors never matched any element during this capture.

| Selector group                                                        | Matching time | Attempts | Fast rejections | Matches |
| --------------------------------------------------------------------- | ------------: | -------: | --------------: | ------: |
| `:is(.oc-overlay, .oc-modal-dialog) *`                                |     76.655 ms |   53,431 |               0 |       0 |
| `:is(.oc-overlay, .oc-modal-dialog) ::-webkit-scrollbar`              |     73.642 ms |   53,431 |               0 |       0 |
| Four explicit-ancestor equivalents, combined                          |      6.596 ms |  221,188 |         221,188 |       0 |
| All `:has()` selectors, baseline                                      |     54.270 ms |  191,936 |               — |       — |
| Largest individual `:has()` (virtual row containing a Markdown table) |     17.963 ms |    2,670 |               0 |       0 |

The first two selectors account for 18.0% of baseline selector matching time (833.237 ms total). Explicit alternatives let the browser reject nonoverlay ancestor chains early, reducing those groups' diagnostic matching time by 95.6%, despite twice as many cheap attempts. All `:has()` selectors together account for 6.5%; no individual Web Awesome selector appears among the ten largest costs. Aggregate library-level shadow stylesheet cost was not separately isolated.

### Style and layout by reload phase

A final untraced diagnostic uses `console.timeStamp` and CDP `Performance.metrics` snapshots at hello delivery, first row attachment, reveal, and settle. These two extra diagnostic captures are excluded from the seven-pair comparison. Durations below are differences between native counter snapshots; this is one baseline capture, not a median.

| Phase                      | End after navigation |      Style |    Layout | Style recalcs | Layouts |
| -------------------------- | -------------------: | ---------: | --------: | ------------: | ------: |
| Document → hello           |             235.0 ms |  11.942 ms |  1.173 ms |            11 |       5 |
| Hello → first row attached |             336.8 ms |  15.049 ms |  2.514 ms |            17 |       3 |
| First row → reveal         |             392.8 ms |  13.124 ms |  2.889 ms |             9 |       7 |
| Reveal → fixture settled   |            3932.8 ms | 488.664 ms | 33.506 ms |           247 |      52 |

About 92% of this capture's style work happens after initial transcript reveal. One main-frame trace has 58 layout envelopes rooted at the document and two at the virtual transcript extent. That is a regional boundary census, not a claim that document-root layout belongs exclusively to the sidebar or transcript. Mutation and selector evidence implicate repeated shell-wide matching, not only the ten initial rows.

Raw trace `Layout` envelopes must not be added to style counters as independent CPU buckets. Chromium's native counters subtract nested style/layout work from one another ([counter implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc)); the traced envelope and native exclusive budget differ substantially here. The native counter comparison is approximately 40 ms layout versus 507 ms style. The earlier 83 ms geometry code bucket is not proof of 83 ms exclusive browser layout on this cached fixture.

The document/root probe saw 18 initial writes, ending around 215 ms in its traced baseline, before hello. It did not show repeated late theme or text-scale toggles invalidating the populated document. Moving those initial theme writes would not address the measured post-reveal style budget.

### Why the CLS gate fails

The final shift-source diagnostic catches a **0.0095365** shift at approximately 394.6 ms: `openclaw-router-outlet` moves from x=330, width=1369 to x=310, width=1409; height remains 1179. It is a 20 px inset disappearing on both sides before contentful paint. Other smaller shifts affect composer controls, header identity/facepile, transcript horizontal placement, and sidebar metadata.

The shell initially applies `.content`'s 20 px inline padding (`ui/src/styles/layout.css`). The mounted chat pane publishes `{ workbench: true }` from `ChatPaneRuntimeView`'s `onSettled` (`ui/src/pages/chat/chat-pane-runtime-view.tsx`); `.content--chat.content--workbench` then removes that padding in `ui/src/styles/chat/startup-layout.css`. The trace shows the boot chat styles parsed before hello, so simply moving this rule into another eager sheet is not an evidenced fix. The remaining handoff is route/layout-trait ownership and first-paint timing. Its larger shift also occurs in baseline runs; the faster selector candidate exposes the high-shift mode more often in this sample. Do not claim that an equivalent selector rewrite changes final layout semantics.

The next useful decision is whether the initial route layout owner should present the final workbench geometry before pane mount, while preserving New Session, Systems, pending-create, and not-found layouts. That owner change was not added to this CSS cost experiment. No DOM shell replay, worker, transport scheduling, compile-hint, or compression approach was retried.

### Proof, artifacts, and disposition

AWS run: https://crabbox.openclaw.ai/portal/runs/run_ff6a12c8eadc37e26b75fb2026cd842a. The initial remote-clone run built the production UI and completed all containment captures; selector and phase diagnostics reused its authenticated SSH route on the same retained lease, same head, same bundle. Crabbox emitted one nonfatal telemetry-upload warning; all local artifact transfers completed and all 52 capture files are present.

The production fixture assertions passed in every capture: title, 30 attached pins, plugin navigation, board widget, last transcript widget, drained RPC/event queues, and saved sidebar state. Synthetic settled before/after screenshots were inspected for containment and the selector rewrite. The screenshots have no real account or conversation content and remain local. No private campaign capture was uploaded or quoted.

Autoreview is scoped-clean through P2 for the selector source equivalent; it confirms matching and specificity preservation. The source candidate is reverted. No unit-test files were changed. Focused native UI E2E, WebKit overlay suites, full UI E2E, and changed-file gates were not run for discarded candidates; no shipping validation is claimed. The report-only draft's context/evidence checks passed at the experiment head; runtime CI was skipped because it is a draft.

The rejected source equivalent was **+6 runtime lines** and is preserved in `.local/l71/rejected-selector.patch`. Final runtime production LOC delta: **0**. The branch contains only this nonproduction report; the requested diff-stat filter includes the Markdown report, which is not runtime code. No changelog or release note is needed.

Local proof: `.local/l71/results/`, `selector-results/`, `phase-results/`, their comparison JSON and raw traces/screenshots, `rejected-selector.patch`, review logs, and `stop.log`. The AWS lease was released; no Gateway was started. Close the experiment-only draft. There is no ready PR or production patch to land.
