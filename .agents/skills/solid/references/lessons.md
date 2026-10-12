# Lessons learned

Each entry cost at least one failed CI run, a reverted approach, or a blocked PR during the Lit → Solid 2 migration (October 2026). Read before a new kind of change.

## Solid 2 semantics

- **Writes are deferred.** A setter's value is visible only after the microtask flush. That's why owners stay plain TypeScript and components derive instead of write-then-read. A signal-backed store broke callers that mutate and immediately read.
- **Effect cleanup also runs for equal computed values.** A bridge props refresh can rerun `createEffect` even when its selected status is unchanged, canceling a timer without restarting it. Feed lifecycle effects through a `createMemo` when cleanup must follow value transitions; this kept the saved-status timer from hiding Apply indefinitely.
- **Publish related lifecycle facts together.** A retained Board app reactivated with the new `active` prop and the previous inactive visibility snapshot, briefly tearing down its iframe and losing drafts. Recheck visibility before publishing activity and consume both from the same lifecycle projection.
- **Removed namespaces compile silently.** `on:click`, `attr:`, `bool:`, `classList`, and `use:` don't error; they become literal attributes or no-ops. Lint is the only guard.
- **Event names are case-sensitive.** `onWaSelect` listens to `waselect`, not `wa-select`. Use `onWa-select` or `listen(...)`.
- **Async memos aren't cancellable.** They drop superseded results but get no `AbortSignal`. Transport cancellation needs an owned async-iterable adapter.
- **Ref callbacks are unowned.** `onCleanup` inside one never runs. Set up behavior in the component body or an owned ref factory.
- **`guard` isn't `equals`.** A memo's `equals` runs after computing. Lit's `guard` skipped the render work entirely. Reproduce it with a dependency memo that compares the explicit dependency vector, read from an untracked render computation.
- **Strict JSX types catch real bugs.** `aria-pressed` accepts `"true" | "false" | "mixed"`, not a boolean; a generic `onChange: (value: T) => …` doesn't narrow to `string` across the bridge. Fix the types, don't cast.

## Interop

- **A tag can have only one class.** Our first plan kept Lit versions of shared primitives for unported callers while Solid rendered the same tags. The browser upgrades any element with a registered tag, so Lit rendered over Solid's children. The fix is one implementation per tag plus the bridge.
- **Don't block the old path before the new one works.** The Lit ratchet landed before anyone could mount a Solid component, and it blocked feature PRs that legitimately added Lit UI. Migration guards start advisory. Enforce in the PR that makes the replacement usable, and only for new files.
- **Bridges need the boring cases tested.** Properties set before upgrade, moves within one task, Lit part markers in child content, and context replacement each broke a first draft.
- **Create content under the owner that retains it.** A Solid history header created inside a transient projection memo was disposed while a separate transcript root still displayed it. Pass the legacy template through and let the retained renderer mount it; otherwise retry, reconnect loading, and automatic history paging lose their control.
- **Lit disconnection can mean parking.** `setConnected(false)` on a retained range must park nested Solid roots rather than recreate their controls on reveal. Preserve their presentation context and retire them with the containing range, including removal while already parked; otherwise sidebar return-focus targets and restored transcript geometry disappear.
- **Commit timing exposes stale geometry state.** Solid's later measurement can reach the transcript end through a programmatic scroll after the pane rendered its latest button. Update the geometric affordance on that arrival while preserving reader intent; a maintenance correction must not unlock following. Hide it immediately when the end is reached: a delayed CSS visibility transition can otherwise leave the obsolete control visible after layout has settled.
- **Refs can precede document adoption.** A Solid template element can still belong to an inert document when its ref runs, so `ownerDocument.defaultView` is null. Bind global listeners through an already mounted owner and retain that exact window for cleanup; otherwise hover-only Escape silently stops working while focused key handlers still pass.

## Testing and tooling

- **Wait for the committed preference receipt.** Preference writes adopt the returned config revision without another `config.get`. Appearance and reconnect E2E tests that waited for that removed read timed out before checking the UI. Wait for the acknowledged config and retired pending intent; preserve contrast, selection, and reconnect assertions.
- **Lazy hooks break one-shot readers.** Making `window.openclawControlUi` load on first read fixed the startup budget, then failed two scheduled E2E tests whose helper read the hook once and threw. Every reader of a lazy fact must wait for it.
- **Chunk fixtures target emitted implementations.** A `.ts` re-export facade may disappear from source maps after a TSX port. Lazy-load fault injection must resolve the emitted implementation, as the System busyness frame tests now do.
- **Mock every exercised RPC with its real result shape.** Meetings' generic `{}` response for an unconfigured summary-generation request caused a render error that Lit later recovered from but Solid retained. Hold generation until the scenario supplies its typed result; don't add production guards for invalid test responses.
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
- **Ports grow unless you push back.** First drafts came in 7% to nearly 3x larger than the Lit they replaced (formatter-expanded JSX, wrapper layers, defensive branches). Ask for net LOC at or below the original and explain any growth.
- **Attribute, don't stop.** A failing check gets rerun on the merge base. The same failure there means it's inherited: record it and continue.
- **Startup bytes vary by machine.** Compare the merge base and the head on the same host before blaming a change.
