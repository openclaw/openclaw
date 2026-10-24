# Performance

Delete unnecessary work before batching or caching; follow the [performance workflow](../../openclaw-performance/SKILL.md). Check the installed `ui/node_modules/solid-js/CHEATSHEET.md` and types for exact APIs. The upstream [Solid 2 migration guide](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/MIGRATION.md) explains the model; the installed version owns the contract.

## Startup bundle

`scripts/check-control-ui-performance.mts` and `config/control-ui-startup-budget-baseline.json` own startup measurement and enforcement: the committed gzip baseline plus growth and build-variance allowances, and one startup CSS request. The baseline itself may not exceed the script's `startupJsGzipBytes` cap. Preserve the lazy graph and compare every changed boot surface against its merge base. A surface already above its cap may not grow beyond the 64-byte build-variance allowance. Lower the startup baseline with the official `--update-baseline --reason` command after a verified reduction, using the measured head value rather than a lower target; raising budgets needs owner approval.

- Keep code out of the startup graph until a startup surface actually needs it. Defer behind the route or interaction that uses it: automation readiness loads on the first read of its hook, and System busyness renders only when opened.
- The Solid shell now owns startup rendering. Its imports must not eagerly register lazy page custom elements or load route-only libraries, even if every importer uses Solid. An eager Zod import previously added about 36 KB gzip.
- Icons and shared primitives are on the startup path. A primitive change must not grow startup bytes, so measure it.
- Measure with `pnpm ui:build` plus the strict performance check, and compare against the merge base on the **same machine**. The same commit can differ by several hundred bytes between environments.

## Rendering

- Fine-grained updates keep invalidation local. A component re-runs nothing; only the computations that read a changed signal do. Don't recreate that broadness with large memos over whole snapshots: derive narrowly.
- Large transcripts stay on the existing virtualizer owners; no `@tanstack/solid-virtual`.
- Streaming markdown goes through the framework-neutral `MarkdownDomReconciler`, driven from a ref factory; Solid never renders inside the markdown island.
- xterm, noVNC, and iframes own their DOM: Solid hosts the island and never renders inside it.

### Lists and identity

Choose the row lifetime deliberately; see [keying](idioms.md#key-lists-by-the-lifetime-you-intend). Never key entities by index or streaming text.

| Form                                        | Lifetime                                                    | Child arguments               |
| ------------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| `<For each={rows()}>`                       | Item identity; fresh objects remount rows                   | Raw item, index accessor      |
| `<For each={rows()} keyed={row => row.id}>` | Stable entity key across refreshed objects                  | Item accessor, index accessor |
| `<For each={rows()} keyed={false}>`         | Position; use when the slot is the identity                 | Item accessor, numeric index  |
| `<Repeat count={n}>`                        | Count/range without list diffing; skeletons or window slots | Numeric index                 |

Call accessors inside JSX or a memo, not at the top of the child callback. A keyed row is `{row => <Row item={row()} />}`. Polls, reconnects, history reloads, and `.map()` can produce fresh objects: use stable keys or reconcile them into the existing presentation store instead of relying on object identity.

### Derivations and memos

- Keep authoritative domain state in its plain TypeScript owner. For structured presentation data, `createProjection(() => sourceRows(), [], { key: "id" })` reconciles refreshed rows and lets readers subscribe to the fields they use. The draft form can update selected fields in place. Use `createStore(fn, seed, options)` when that derived presentation store also needs a local setter; see [async and actions](async-and-actions.md).
- For an existing store, reconcile inside its setter: `setStore(draft => { reconcile(nextRows, "id")(draft.rows); })`. `reconcile(value, key)` returns a transform; returning a replacement array from a plain setter does not do keyed reconciliation. A memo that maps fresh row objects can cause identity churn, but not every array needs a projection: choose it when retained row identity or field-level subscriptions remove measured work.
- Prefer stores/projections over hand-built per-key signal maps without current evidence. Earlier projection root-write and V8 keyed-record cliffs were fixed upstream in [#3354](https://github.com/solidjs/solid/pull/3354) and [#3695](https://github.com/solidjs/solid/pull/3695), respectively; those reports do not establish a cliff in the installed runtime.
- Keep cheap expressions in JSX or accessors. Use `createMemo` for expensive/shared work or useful equality filtering. `equals` suppresses downstream notification when the comparison holds; compare immutable values and include every field readers need. Comparing only IDs hides changed labels if readers also consume labels.
- `createMemo(fn, { lazy: true })` defers computation until first read and disposes it when no subscribers remain; the next read recomputes it. Use this for expensive hidden/collapsed content only when it is actually unobserved, not merely hidden with CSS, and does not need to retain state while idle.

### Copies and batching

- Read store fields directly in reactive rendering. Reserve `snapshot(store)` for serialization, persistence, external messages, or plain-object assertions. It is non-tracking, so a snapshot alone does not subscribe to future changes. The installed runtime can reuse unchanged source subtrees and copies modified owned data: it is not unconditionally a full clone, nor does it always produce new identities. Repeated snapshots can still copy large changed subtrees. `structuredClone` and JSON round trips also add copying work; keep them out of row rendering, typing, and streaming unless the boundary requires them.
- Writes batch by default at the microtask boundary. Several synchronous writes share that batch; asynchronous transitions can settle later. Do not add `flush()` to read back your own write: derive the next value or pass it to the operation that needs it.

### Events and layout

- Prefer JSX handlers. Supported bubbling events are delegated through render roots, which release their container listeners on disposal; not every event delegates. Follow the [event ownership rules](idioms.md#props-and-events-stay-live) for native options, external targets, and custom-element boundaries. Do not build a manual per-row listener system to avoid JSX callbacks.
- Virtualize measured large-list bottlenecks with the existing `@tanstack/virtual-core` integration. Preserve keyboard navigation, type-ahead, active-item visibility, `aria-activedescendant`, and list position/size. With 1,000 models, desktop open-and-search task median fell from 387.9 to 151.5 ms in [#181190](https://github.com/openclaw/openclaw/pull/181190).
- Offscreen containment can cut style/layout work while preserving scroll geometry ([#181015](https://github.com/openclaw/openclaw/pull/181015)). Prefer transform or clipping on a fixed-width panel over animating width through a large layout; the quiet-host desktop sidebar task median fell from 694.18 to 396.98 ms in [#181048](https://github.com/openclaw/openclaw/pull/181048). Preserve flyouts, hit testing, RTL, and reduced motion.
- Use class object/array forms, such as `class={["row", { active: isActive() }]}`, rather than rebuilding conditional strings.

## Plugin bundles

Plugin views ship their own Solid runtime (the X plugin bundle went from 36 KB to 83 KB; Workboard grew by 62 KB). That's accepted: plugins can't share the host's private modules. Keep each plugin within its asset limits.

## Measured lessons

These are results for the cited workloads, not universal speedups.

- **Streaming:** narrowing subscriptions reduced whole-pane renders from 353 to 1 and script CPU by 51% ([#180884](https://github.com/openclaw/openclaw/pull/180884)). Reuse settled Markdown blocks. The incremental Markdown pipeline in [#181828](https://github.com/openclaw/openclaw/pull/181828) was reverted by [#181856](https://github.com/openclaw/openclaw/pull/181856): bookkeeping offset sanitizer savings, and only 120 of 1,283 sanitizer calls used text-only patches. See [lessons](lessons.md#streaming-markdown-performance) before trying it again.
- **Session switch:** retain prepared transcript rows within the existing bounded pane cache; invalidate only consumers of changed facts ([#181278](https://github.com/openclaw/openclaw/pull/181278)).
- **Filtered typing:** avoid re-sorting unchanged inventories on each keystroke. Narrowing the row source kept the existing request coalescer and reduced desktop Cron typing task median from 265.5 to 179.2 ms ([#181599](https://github.com/openclaw/openclaw/pull/181599)).
- **Boot and CSS:** keep component/content renderers and locale namespaces behind their owning lazy boundaries. Consolidating sheets already fetched together cut Chat from eight to three CSS requests ([#181255](https://github.com/openclaw/openclaw/pull/181255)). At 100 ms latency, readiness medians improved 36–58%; zero-latency results stayed within the acceptance band. Measure local and remote profiles before judging transport changes; ratchet budgets to the measured head, never below it.
- **Memory:** callbacks, fallback providers, and unstarted bootstrap work outlived their owners ([#181259](https://github.com/openclaw/openclaw/pull/181259)). Fix the retaining owner. Dependency-owned select/pending-computation retention needed exact-version patches and prepared upstream reports ([#182101](https://github.com/openclaw/openclaw/pull/182101)); that PR did not publish the reports upstream.

## Measuring

- State the workload and acceptance rule before measurement. Use the existing [warm-interaction harness](../../control-ui-e2e/references/interaction-performance.md), [cold-load/streaming/session-switch benchmarks](../../../../scripts/bench-control-ui-cold-load.ts), and [retention proof](testing.md). Synthetic fixtures measure renderer cost, not live Gateway or provider latency.
- Timing claims need at least ten serial interleaved base/head pairs on the same host, with median, p95, min–max, and host load. Separate cold/warm and traced/untraced runs. A timing cell is clean when median regression is at most 5% and p95 is no worse, or ten more pairs confirm that band; sub-1% p95 movement is noise unless repeated pairs confirm it. A regression beyond the performance workflow's 20% rule blocks. A missed numeric target does not block a clean measured win; report the gap.
- Use an immediately available quiet Testbox when appropriate; cancel queued allocations and measure locally with host load recorded. A single trace identifies costs, not a latency improvement.
- Count work as well as time: row creation, pane renders, memo recomputations, requests, retained owners. Use existing counters or focused development instrumentation; do not ship diagnostic state just for a benchmark.
