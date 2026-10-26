# Lessons learned

These lessons came from the completed Lit → Solid 2 migration (October 2026). Lit and Web Awesome are gone from the Control UI and plugin views; historical examples below preserve the failures that explain current ownership rules. Read before a new kind of change.

## Solid 2 semantics

- **Writes are deferred.** A setter's value is visible only after the microtask flush. That's why owners stay plain TypeScript and components derive instead of write-then-read. A signal-backed store broke callers that mutate and immediately read.
- **Effect cleanup also runs for equal computed values.** A bridge props refresh can rerun `createEffect` even when its selected status is unchanged, canceling a timer without restarting it. Feed lifecycle effects through a `createMemo` when cleanup must follow value transitions; this kept the saved-status timer from hiding Apply indefinitely.
- **Native `value` bindings rewrite on every rerun.** The compiled binding assigns `input.value` whenever its effect reruns, even with an equal value. Read through a spread props object, it reruns on every unrelated refresh and wipes uncommitted text; Settings lost a typed message width this way while hydrating. A `createMemo` of the owner value isolates its updates only when the binding effect has no other reactive attributes. The compiler can group `value` with validation attributes, so use the existing `liveValue` ref from `lib/reactive/live-value.ts` for commit-on-change drafts; its separate effect preserves typed text when validation changes. Key a DOM-owned input's lifetime to its logical step identity so consecutive steps with equal defaults still reset the draft.
- **Publish related lifecycle facts together.** A retained Board app reactivated with the new `active` prop and the previous inactive visibility snapshot, briefly tearing down its iframe and losing drafts. Recheck visibility before publishing activity and consume both from the same lifecycle projection.
- **Removed namespaces compiled silently before rc.18.** `on:click`, `attr:`, `bool:`, `classList`, and `use:` became literal attributes or no-ops. rc.18 rejects native JSX uses; lint still guards spreads.
- **Event names are case-sensitive.** Dashed custom events need the exact dash in their JSX handler name, or a `listen(...)` subscription.
- **Async memos aren't cancellable.** They drop superseded results but get no `AbortSignal`. Transport cancellation needs an owned async-iterable adapter.
- **Ref callbacks are unowned.** `onCleanup` inside one never runs. Set up behavior in the component body or an owned ref factory.
- **Capture native ref keys in the factory, not its callback.** rc.16 resolves `ref={[rowRef(item().id)]}` under `untrack` with the owner intact, then invokes the returned callback unowned. That callback still inherits strict-read diagnostics, so reading `item()` there warns. Let `rowRef(id)` register cleanup and return a callback over the plain key; registration remains synchronous. A replaceable child branch can attach its successor before disposing the old ref: delete a keyed registration only if it still belongs to that element. Component ref props are ordinary props and do not have this native-element resolver contract.
- **Equality doesn't skip computing.** A memo's `equals` runs after computing. When expensive rendering must be skipped entirely, compare an explicit dependency vector in a memo and read it from an untracked render computation.
- **Strict JSX types catch real bugs.** `aria-pressed` accepts `"true" | "false" | "mixed"`, not a boolean; a generic `onChange: (value: T) => …` doesn't narrow to `string` across the bridge. Fix the types, don't cast.
- **Optional contexts need a real default.** Solid 2 treats `undefined` as unset even when passed to `createContext`; use `null` for an optional owner and keep standalone component tests in the proof.

### rc.14 upgrade

The [rc.14 changelog](https://github.com/solidjs/solid/blob/8d23a5a13b23f8bfd5f01ceca5d2a73305d11fd7/packages/solid/CHANGELOG.md) and sibling package changelogs add these migration constraints:

- **Writable derivations run after local writes.** When a source changes, `createSignal(fn)` and `createStore(fn)` re-derive from the manually written `prev` or draft, including in the same update. A derivation that ignores it can replace the local write. This does not change the rule that domain owners stay plain TypeScript.
- **Only uppercase event prefixes bind handlers.** `onClick` binds; `onclick`, `onmouseover`, and `on:click` are attributes. rc.14 adds the `LOWERCASE_EVENT_ATTRIBUTE` diagnostic; keep the existing camelCase and dashed-custom-event conventions.
- **Dynamic refs run before child insertion.** `dynamic()` and `<Dynamic>` now match compiled elements. A ref must not assume its children are already present.
- **Effect tuples infer as const.** `createEffect` and `createRenderEffect` retain inline tuple element types without extra casts. Consumers that only read those facts must accept readonly arrays, as the hosted-tab notifier does.
- **Effect callbacks cannot create primitives implicitly.** Capture the component owner and use `runWithOwner` when a callback deliberately mounts projections or nested Solid roots. Signals published by those adapters need `ownedWrite: true` for intentional writes under the restored owner.
- **Async functions can have synchronous fast paths.** A prepared board skips its first `await`, so binding its projection still needs the effect caller's captured owner.
- **Error rendering must not republish unchanged state.** A board fallback that repeatedly set its existing error flag and invalidated its own render spun under rc.14. Publish only the transition into the error state; retain explicit reset on a new binding.
- **Teardown releases resources without publishing state.** Keep signal updates in live error/visibility handlers; cleanup only aborts work and releases resources. A video-poster cleanup write failed when its rendered parent was disposed.
- **RPC fixtures must return fresh snapshots.** Reusing and mutating objects already passed into a store bypasses reactive updates. Clone mock responses when simulating later JSON replies, as the snapshot polling test does.
- **Binding slots were renamed.** `BindingSlot` replaces `AttributeSlot` without an alias and restricts fill output types. OpenClaw currently uses neither API.

### rc.16 upgrade

The [rc.16 changelogs](https://github.com/solidjs/solid/tree/b0ad1df505b835058a4b3750ab37d6576bb18c01/packages) and shipped `CHEATSHEET.md` refine these contracts:

- **Teardown writes are supported.** rc.16 exempts cleanup callbacks from the dev owned-write restriction and fixes cleanup writes stranding later transactions. The rc.14 failure above is historical; keep teardown focused on releasing resources rather than republishing disposed view state.
- **Object derivations may omit a seed.** `createStore(fn)`, `createProjection(fn)`, and `createOptimisticStore(fn)` accept complete object answers without an invented `{}` seed. A provided seed must be a complete value; arrays still need `[]`.
- **Deferred reads declare lag.** `createDeferred` suspends for its first answer, then keeps the previous answer during refetch without holding unrelated rendering. `isPending` still reports the refetch. Adopt only where stale presentation is intended.
- **Held errors land with held values.** Until that commit, ordinary readers and `Errored` retain the previous frame; `latest` can expose the proposed error. `untrack` does not turn an unresolved read into a fallback.
- **Loading resets consume values.** Use `on={identity()}`; an accessor passed as `on` never reads its dependency. Refresh a derived store at its root, then read the nested value after settlement.
- **Providers own subtree state.** The cheatsheet now recommends provider-created state for portable request isolation; module scope is shared by server requests. OpenClaw's plain TypeScript domain owners retain their existing authority and lifetime.
- **Binding slots are removed.** `BindingSlot`, `SlotOutput`, `SlotError`, and the frames `bind` entry are gone. OpenClaw uses none of them; ordinary slots remain.

### rc.18 upgrade

The [rc.17 and rc.18 changelogs](https://github.com/solidjs/solid/tree/225014bf8757421a2ea0a9c6ddc148b965eed000/packages) refine these contracts:

- **Cleanup failures do not interrupt teardown.** All sibling cleanups run; the first error is rethrown after disposal or the current flush completes. Do not depend on a throw preventing later cleanup.
- **Rejected replacements retire the previous frame.** An async memo's committed run stays alive until its replacement lands, including rejection; an uncommitted superseded run is cleaned up immediately.
- **Store adoption preserves moved rows.** Reconcile and derived-store adoption no longer alias slots when existing raw objects move or swap. Keep semantic keys where row identity is a product contract; do not add cloning workarounds.
- **Effects do not compare computed values.** Cleanup and apply run whenever compute runs, even for equal answers. Put a memo at the dependency boundary when equality should suppress the effect.
- **Native legacy JSX is rejected by the compiler.** `on:`, `oncapture:`, `attr:`, `bool:`, `use:`, and `classList` now fail compilation; spreads still require lint. A bare `prop:active` writes `true`.
- **Input warnings identify lost drafts.** `UNCOMMITTED_INPUT_OVERWRITTEN` names a binding overwriting an uncommitted DOM edit. Use a draft signal, `liveValue`, or a native default; write rejected edits back in the handler instead of setting `equals: false`.
- **Synchronous DOM events have their own dev phase.** Focus/click/dialog events triggered by an effect no longer inherit its strict-read or primitive-creation diagnostics. Keep actual effect callbacks within the existing ownership rules.
- **`from` owns a latest-value subscription.** `createMemo(() => from(source))` closes a callback subscription, Observable, or AsyncIterable on supersession/disposal. Subscription values coalesce; ordered domain events must retain their direct subscription. Prefer returning `from` directly rather than consuming it after an `await`, where the owner is lost.
- **Vite deduplicates production runtimes.** next.51 deduplicates the three runtime packages in builds as well as dev. It no longer supplies a default `jsdom` test environment; every DOM test configuration must select its environment explicitly.

## DOM ownership

- **A tag can have only one renderer.** During migration, duplicate primitive implementations let custom-element upgrades render over Solid's children. Native custom elements and their Solid callers now share one implementation through the bridge.
- **Bridges need the boring cases tested.** Properties set before upgrade, moves within one task, caller-owned child ranges, and context replacement each broke a first draft.
- **Create content under the owner that retains it.** A Solid history header created inside a transient projection memo was disposed while a separate transcript root still displayed it. Create the content under the retained renderer's owner; otherwise retry, reconnect loading, and automatic history paging lose their control.
- **Hiding can mean parking.** Hidden retained surfaces must park their Solid roots rather than recreate their controls on reveal. Preserve their presentation context and retire them with the containing range, including removal while already parked; otherwise sidebar return-focus targets and restored transcript geometry disappear.
- **Commit timing exposes stale geometry state.** Solid's later measurement can reach the transcript end through a programmatic scroll after the pane rendered its latest button. Update the geometric affordance on that arrival while preserving reader intent; a maintenance correction must not unlock following. Hide it immediately when the end is reached: a delayed CSS visibility transition can otherwise leave the obsolete control visible after layout has settled.
- **Refs can precede document adoption.** A Solid template element can still belong to an inert document when its ref runs, so `ownerDocument.defaultView` is null. Bind global listeners through an already mounted owner and retain that exact window for cleanup; otherwise hover-only Escape silently stops working while focused key handlers still pass.
- **Controlled custom elements can mutate themselves.** A native control can change before its selection handler runs. Restore the authoritative value when handling a selection whose result stays equal; an unchanged Solid prop does not necessarily rewrite the DOM.
- **DOM retention and media custody have different lifetimes.** Keep a transcript root across same-task pane moves so retained table observers survive. Retire a pending inline-to-canonical image handoff synchronously at its media owner; deferring the entire disconnect lets cancelled preview pixels survive reconnection.
- **Reader intent is a visible anchor, not a virtual offset.** Persistence can regroup rows above the viewport and legitimately change `scrollTop`. Assert the visible message stays in place and following remains locked; pinning the old offset rejects the correction that preserves the reader's position.

## Streaming Markdown performance

- **Fewer HTML assignments did not justify a second incremental pipeline.** PR #181828 retained sanitized subtrees and single-line paragraph checkpoints, but ten original interleaved pairs moved scripting CPU only 1,735 → 1,716 ms (1.1%). Reprofiling the same 400-message, 645-delta workload found DOMPurify improved 250 → 134 ms while total Markdown preparation stayed 424 → 430 ms. The parser-entry union was 97 → 103 ms: counting only Markdown-it's public `render` hid work moved into the new wrapper. Recursive raw-tree inspection, cloning, serialization, descriptor construction, and joins offset the sanitizer savings. The pipeline was reverted; the live-DOM split-fuzz/XSS corpus and canonical completion ordering remain.
- **Measure the fallback mix before retaining parser state.** In the reassessment diagnostic, text-only patches handled 120 of 1,283 sanitizer calls. All 346 fence and 221 table calls still parsed the tail; the benchmark has no lists. Fences change their encoded copy attribute, tables require whole-block sanitization, and paragraph checkpoints still run every inline rule. Compare end-to-end scripting CPU and responsiveness, report new wrapper costs as well as removed library calls, and prove at least a 10% win before retrying this design. Never weaken the DOMPurify boundary to improve the hit rate.

## Testing and tooling

- **Wait for the committed preference receipt.** Preference writes adopt the returned config revision without another `config.get`. Appearance and reconnect E2E tests that waited for that removed read timed out before checking the UI. Wait for the acknowledged config and retired pending intent; preserve contrast, selection, and reconnect assertions.
- **Lazy hooks break one-shot readers.** Making `window.openclawControlUi` load on first read fixed the startup budget, then failed two scheduled E2E tests whose helper read the hook once and threw. Every reader of a lazy fact must wait for it.
- **Chunk fixtures target emitted implementations.** A `.ts` re-export facade may disappear from source maps after a TSX port. Lazy-load fault injection must resolve the emitted implementation, as the System busyness frame tests now do.
- **Mock every exercised RPC with its real result shape.** Meetings' generic `{}` response for an unconfigured summary-generation request caused a retained render error. Hold generation until the scenario supplies its typed result; don't add production guards for invalid test responses.
- **WebKit surfaces late dependency optimization.** Vite re-optimized `@solidjs/signals` mid-run and reloaded the page, which looked like 14 WebKit "import failures". Pre-include Solid runtime packages in the browser test config.
- **Scope the Solid plugin, always.** Solid's Vite plugin defaults an unspecified test environment to `jsdom`. Added unscoped to the Node Vitest configs, it broke about 25 Gateway database-worker shards ("The URL must be of scheme file", corrupt worker frames). The shared config in `ui/config/control-ui-solid.ts` takes explicit include globs, and Node projects pin `environment: "node"`.
- **Node tests import UI code too.** 37 non-UI test files import `ui/src/**`. Once a reachable module became `.tsx`, a Gateway integration test failed to parse at suite level. Node projects compile `ui/**/*.tsx` and `extensions/*/browser/**/*.tsx` with the same scoped transform, and nothing else.
- **Don't re-evaluate Solid between test files.** Module resets that re-evaluate `solid-js` split the scheduler and context graph across files.
- **`.test.tsx` must be discovered.** Before discovery covered TSX, migrated tests were silently skipped. Confirm new test files appear in the run.
- **Module augmentation needs a module.** A `.d.ts` that augments `@solidjs/web` must import something; the repo's lint forbids `export {}`, so use a side-effect `import "@solidjs/web";`.
- **New type assertions need `// SAFETY:`** comments, or the assertion-safety ratchet fails.
- **Parity needs determinism first.** Same-SHA screenshots differed until rendering was pinned; the remaining nondeterministic shots are listed explicitly, not tolerated globally.

## Process

- **Small PRs land; big ones stall.** A focused 193-line lifecycle PR landed in about 22 minutes. The primitives PR (+7.9K lines) took nine hours of CI repair and blocked nine lanes. Split shared foundations from consumers.
- **Ports grow unless you push back.** First migration drafts came in 7% to nearly 3x larger than the replaced implementation (formatter-expanded JSX, wrapper layers, defensive branches). Ask for net LOC at or below the original and explain any growth.
- **Attribute, don't stop.** Read PR CI failure classification before attribution. Matching-signature pre-existing: record + continue under landing rule. Job-name-only: compare failed tests with main run. New/unknown: investigate; `pnpm test:ci-failed <pr>` selects failed local proof, never whole merge-base suite.
- **Startup bytes vary by machine.** Compare the merge base and the head on the same host before blaming a change.
