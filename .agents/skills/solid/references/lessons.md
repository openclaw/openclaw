# Lessons learned

Each entry cost at least one failed CI run, a reverted approach, or a blocked PR during the Lit → Solid 2 migration (October 2026). Read before a new kind of change.

## Solid 2 semantics

- **Writes are deferred.** A setter's value is visible only after the microtask flush. That's why owners stay plain TypeScript and components derive instead of write-then-read. A signal-backed store broke callers that mutate and immediately read.
- **Removed namespaces compile silently.** `on:click`, `attr:`, `bool:`, `classList`, and `use:` don't error; they become literal attributes or no-ops. Lint is the only guard.
- **Event names are case-sensitive.** `onWaSelect` listens to `waselect`, not `wa-select`. Use `onWa-select` or `listen(...)`.
- **Async memos aren't cancellable.** They drop superseded results but get no `AbortSignal`. Transport cancellation needs an owned async-iterable adapter.
- **Ref callbacks are unowned.** `onCleanup` inside one never runs. Set up behavior in the component body or an owned ref factory.
- **`guard` isn't `equals`.** A memo's `equals` runs after computing. Lit's `guard` skipped the render work entirely. Reproduce it with a dependency memo that compares the explicit dependency vector, read from an untracked render computation.
- **Strict JSX types catch real bugs.** `aria-pressed` accepts `"true" | "false" | "mixed"`, not a boolean; a generic `onChange: (value: T) => …` doesn't narrow to `string` across the bridge. Fix the types, don't cast.

### rc.14 upgrade

The [rc.14 changelog](https://github.com/solidjs/solid/blob/8d23a5a13b23f8bfd5f01ceca5d2a73305d11fd7/packages/solid/CHANGELOG.md) and sibling package changelogs add these migration constraints:

- **Writable derivations run after local writes.** When a source changes, `createSignal(fn)` and `createStore(fn)` re-derive from the manually written `prev` or draft, including in the same update. A derivation that ignores it can replace the local write. This does not change the rule that domain owners stay plain TypeScript.
- **Only uppercase event prefixes bind handlers.** `onClick` binds; `onclick`, `onmouseover`, and `on:click` are attributes. rc.14 adds the `LOWERCASE_EVENT_ATTRIBUTE` diagnostic; keep the existing camelCase and dashed-custom-event conventions.
- **Dynamic refs run before child insertion.** `dynamic()` and `<Dynamic>` now match compiled elements. A ref must not assume its children are already present.
- **Effect tuples infer as const.** `createEffect` and `createRenderEffect` retain inline tuple element types without extra casts. Consumers that only read those facts must accept readonly arrays, as the hosted-tab notifier does.
- **Binding slots were renamed.** `BindingSlot` replaces `AttributeSlot` without an alias and restricts fill output types. OpenClaw currently uses neither API.

## Interop

- **A tag can have only one class.** Our first plan kept Lit versions of shared primitives for unported callers while Solid rendered the same tags. The browser upgrades any element with a registered tag, so Lit rendered over Solid's children. The fix is one implementation per tag plus the bridge.
- **Don't block the old path before the new one works.** The Lit ratchet landed before anyone could mount a Solid component, and it blocked feature PRs that legitimately added Lit UI. Migration guards start advisory. Enforce in the PR that makes the replacement usable, and only for new files.
- **Bridges need the boring cases tested.** Properties set before upgrade, moves within one task, Lit part markers in child content, and context replacement each broke a first draft.

## Testing and tooling

- **Lazy hooks break one-shot readers.** Making `window.openclawControlUi` load on first read fixed the startup budget, then failed two scheduled E2E tests whose helper read the hook once and threw. Every reader of a lazy fact must wait for it.
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
