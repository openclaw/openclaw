# Lessons learned

These lessons came from the completed Lit → Solid 2 migration (October 2026). Lit and Web Awesome are gone from the Control UI and plugin views; historical examples below preserve the failures that explain current ownership rules. Read before a new kind of change.

## Solid 2 semantics

- **Writes are deferred.** A setter's value is visible only after the microtask flush. That's why owners stay plain TypeScript and components derive instead of write-then-read. A signal-backed store broke callers that mutate and immediately read.
- **Effect cleanup also runs for equal computed values.** A bridge props refresh can rerun `createEffect` even when its selected status is unchanged, canceling a timer without restarting it. Feed lifecycle effects through a `createMemo` when cleanup must follow value transitions; this kept the saved-status timer from hiding Apply indefinitely.
- **Native `value` bindings rewrite on every rerun.** The compiled binding assigns `input.value` whenever its effect reruns, even with an equal value. Read through a spread props object, it reruns on every unrelated refresh and wipes uncommitted text; Settings lost a typed message width this way while hydrating. A `createMemo` of the owner value isolates its updates only when the binding effect has no other reactive attributes. The compiler can group `value` with validation attributes, so use the existing `liveValue` ref from `lib/reactive/live-value.ts` for commit-on-change drafts; its separate effect preserves typed text when validation changes. Key a DOM-owned input's lifetime to its logical step identity so consecutive steps with equal defaults still reset the draft.
- **Publish related lifecycle facts together.** A retained Board app reactivated with the new `active` prop and the previous inactive visibility snapshot, briefly tearing down its iframe and losing drafts. Recheck visibility before publishing activity and consume both from the same lifecycle projection.
- **Removed namespaces compile silently.** `on:click`, `attr:`, `bool:`, `classList`, and `use:` don't error; they become literal attributes or no-ops. Lint is the only guard.
- **Event names are case-sensitive.** Dashed custom events need the exact dash in their JSX handler name, or a `listen(...)` subscription.
- **Async memos aren't cancellable.** They drop superseded results but get no `AbortSignal`. Transport cancellation needs an owned async-iterable adapter.
- **Ref callbacks are unowned.** `onCleanup` inside one never runs. Set up behavior in the component body or an owned ref factory.
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
