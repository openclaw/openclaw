# Refactor checklist: idiomatic Solid 2, less code

Use this when refactoring or reviewing existing Solid code. The migration left
working code that still carries imperative rendering patterns: controller classes, effects that
copy state, imperative listeners, and hand-built class strings. Each row below
is a smell with a measurable count, the idiomatic replacement, and the
exception that justifies keeping it. Measure the touched production files before
and after, and report the counts in the PR. Prefer fewer production lines;
explain growth needed for the idiom or correctness.

The installed `solid-js/CHEATSHEET.md` (rc.16) is the API contract. Its
"What changed from 1.x" list is required reading before the first edit: Solid 2
is neither React nor Solid 1, and both priors produce plausible-looking bugs.

## Measure

`pnpm check:control-ui-controllers` is the enforced native-AST census for
production `ui/src`. Unlike the quick grep below, it counts generic calls,
optional calls, computed literal method names, and named import aliases. It
enforces zero feature-code render effects, zero direct TSX listeners, and zero
DOM queries outside the explicit foreign-DOM owners in the guard, and option-free
literal-only memos. Per-file baselines cover effects, untrack, listeners, DOM
queries, flush, and both owner APIs; Solid owner/flush calls resolve actual imports
including aliases and namespaces, excluding shadowed locals and domain methods.
These baselines prevent counts from rising or moving into unrelated files. After
removing calls, run `pnpm check:control-ui-controllers --prune` and commit the
shrunk baselines with the source change. Staged lint checks the index; CI and
`--base <ref>` compare allowances against the merge base. Do not raise allowances.

Run from the repository root; scope paths to your area:

```sh
area=ui/src/pages/sessions   # your scope
prod() { git grep -nE "$1" -- "$area" ':!*.test.*' ':!**/test-helpers/**' ':!**/e2e/**'; }
prod 'hostConnected|hostDisconnected|requestUpdate\(|class [A-Za-z]+Controller' | wc -l
prod 'createEffect\(' | wc -l
prod 'createRenderEffect\(' | wc -l
prod 'untrack\(' | wc -l
prod 'addEventListener\(' | wc -l
prod 'querySelector(All)?\(' | wc -l
prod 'class=\{`|filter\(Boolean\)\.join\(" "\)' | wc -l
prod '[^a-zA-Z_.]flush\(\)' | wc -l
prod 'runWithOwner\(|getOwner\(' | wc -l
```

## Smells and replacements

| Smell                                                                                                        | Replace with                                                                                                                                                             | Keep only when                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rendering controller (`hostConnected`, `requestUpdate`, `class …Controller` owned by a view)                 | `createThing(deps)` per the [controller recipe](idioms.md#replace-rendering-controllers): signals, memos, `createStore`, owner-scoped setup with `onSettled`/`onCleanup` | It is a plain TypeScript domain owner with synchronous non-UI state and no host/update semantics. Name it as an owner, not a controller.                                                                                             |
| An effect that writes a signal or store from another reactive value                                          | `createMemo`, or a writable derivation `createSignal(() => source())` with a stated reset policy                                                                         | Never. An owned-scope write throws in dev; `untrack` does not exempt it, and `ownedWrite: true` hides the design problem.                                                                                                            |
| A conversion that raises the `createEffect` count                                                            | Setup/teardown in the owning function, derived values in memos, event updates in handlers                                                                                | The effect synchronizes with a real external system (DOM measurement, imperative widget, transport). Comment why.                                                                                                                    |
| `createRenderEffect` in feature code                                                                         | `createEffect(compute, apply)`                                                                                                                                           | Never outside `ui/src/lib/reactive/`.                                                                                                                                                                                                |
| `untrack` silencing a warning or freezing props                                                              | Model the dependency: read in JSX, a memo, or the effect compute phase                                                                                                   | An intentional initial reactive-prop snapshot named `initialX`, or internal use in `ui/src/lib/reactive/` primitives, including repeated projection reads. Effect apply, handlers, and `onSettled` already run untracked.            |
| Direct `addEventListener` in a Solid component                                                               | A JSX handler (`onClick={(e) => props.onX(e)}`), or `lib/reactive/listener.ts` returning teardown from `onSettled` / effect apply                                        | Never in TSX. Plain owners may keep paired platform listeners (AbortSignal, IDB, Worker, WebSocket, RTC, MediaStream). Non-DOM platform listeners whose lifetime is the document, such as service-worker listeners, need no removal. |
| `querySelector` to find your own DOM                                                                         | A `ref` callback or a two-phase ref directive factory                                                                                                                    | Querying a deliberate island (xterm, noVNC, PDF, canvas, markdown reconciler) owned by that island's code.                                                                                                                           |
| Class strings: template literals, `.filter(Boolean).join(" ")`, string concatenation                         | `class={["base", props.class, { active: active() }]}`                                                                                                                    | Never.                                                                                                                                                                                                                               |
| A memo whose callback only returns a literal                                                                 | The literal or a plain accessor                                                                                                                                          | Property/equality boundaries, async reads, and explicit memo options are outside this narrow ban.                                                                                                                                    |
| `flush()` in production code                                                                                 | Derive the value instead of write-then-read; let microtask batching run                                                                                                  | An imperative integration that must observe committed DOM synchronously. Name the integration and keep it at the owner.                                                                                                              |
| `runWithOwner`/`getOwner` capturing owners for nested mounts                                                 | Create primitives in the component or factory body                                                                                                                       | A library adapter mounting Solid content inside a foreign DOM island.                                                                                                                                                                |
| Manual `subscribe`/notify loops in a view                                                                    | `projectOwner`/`projectSource` from `lib/reactive/projection.ts`                                                                                                         | Event APIs whose ordering, replay, or completion contract a latest-value read would lose. Those stay direct subscriptions.                                                                                                           |
| `For each={Array.from({ length: n })}` or index-only maps                                                    | `<Repeat count={n}>` (plain numeric index, no diffing)                                                                                                                   | Real entities need keys: use `For keyed={(x) => x.id}`.                                                                                                                                                                              |
| A `useX()` context wrapper that throws on a missing provider                                                 | `createContext<T>()` without a default (throws `ContextNotFoundError` itself), read with `useContext`                                                                    | The wrapper adds real behavior beyond the throw.                                                                                                                                                                                     |
| `Provider` components, `mergeProps`, `splitProps`, `onMount`, `createResource`, `Index`, `classList`, `use:` | `<Context value>`, `merge`, `omit`, `onSettled`, async computation + `<Loading>`, `For keyed={false}`, `class` arrays/objects, `ref={factory()}`                         | Never: these are Solid 1 and either fail to compile or silently no-op.                                                                                                                                                               |
| Loading flags in local signals around an async read                                                          | An async `createMemo`/`createProjection` under `<Loading>`; `isPending(() => x())` for in-flight changes                                                                 | The flag is an owner's mutation state (saving/admitted/uncertain), which stays at the owner.                                                                                                                                         |
| Hand-rolled keyed merge of server lists into local state                                                     | `createProjection(async () => owner.list(), [], { key: "id" })`, or `reconcile(rows, "id")` inside a store draft                                                         | The list is an owner snapshot; consume it through a projection instead.                                                                                                                                                              |

On rc.16, a return-form object derivation can omit its seed; a provided seed
must be a complete value, and array derivations still need `[]`. Refresh a
derived store at its root, then read the nested value after settlement. A
`Loading` reset uses a value (`on={id()}`), not an accessor. Teardown writes are
now supported by Solid, but disposal still should not republish an owner's
state merely to reset a view that is gone. See the [rc.16 notes](lessons.md#rc16-upgrade).

## Order of work

For the Solid 2 pass, use the [async and action recipes](async-and-actions.md)
and report these counts in the touched production files before and after.
Count the old pattern and its replacement separately; name justified survivors.

| Item             | Audit                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Native handlers  | Conditional/prop handler expressions bound once versus stable callbacks that read current state.                             |
| Lifecycle        | Component-level `onCleanup` versus paired `onSettled` setup/teardown; retain computation cleanup.                            |
| Async reads      | Presentation loading/error/data flags versus owner-backed async reads under `Loading`/`Errored`; keep owner admission facts. |
| Mutations        | Manual saving/rollback state versus `action`, optimistic values, affected facts, and reconciliation; retain owner authority. |
| Code splitting   | Manual component import/signal loaders versus `lazy`; preserve original import timing.                                       |
| Structured state | Immutable array/object signal updates versus store drafts or keyed projections; no writable owner mirror.                    |
| JSX              | Hand-written `createComponent` in `.ts` versus JSX in `.tsx`.                                                                |
| Context          | Wrappers that only rethrow missing providers versus default-less context.                                                    |
| Sibling loading  | Independent asynchronous siblings versus an intentional `Reveal` group.                                                      |
| Owner APIs       | `createRoot`/`runWithOwner`/`getOwner` outside foreign-DOM mounts and reactive primitives.                                   |

An API appearing in the after column is not evidence by itself. Verify that
async reads do not duplicate owner requests, errors are visible, optimistic
proxies cannot become write authority, and `refresh` targets the actual
derivation. A rejected action promise needs an explicit error consumer;
`Errored` does not catch an ignored event-handler promise.

1. Read the module, its owner, its callers, and its tests. Name the contract each
   piece serves before deleting anything.
2. Convert the state model first (controller → `createThing`, copies → memos),
   then lifecycle, then events and refs, then markup cleanups like class arrays.
3. Delete the old class, adapter wiring, and test-only exports in the same PR.
   Tests assert public behavior and cleanup, not internals.
4. Measure again. Explain necessary LOC growth. Effects only survive for genuine
   external synchronization that no shared primitive covers; a comment alone is
   not an exception. Use the shared measurement, observer, timer, media, storage,
   title, and focus/scroll primitives instead of adding effects at call sites.

## Before and after

A view controller with manual updates:

```ts
// Before: a rendering controller owned by one view.
class FilterController {
  query = "";
  constructor(private host: { requestUpdate(): void }) {}
  hostConnected() {
    window.addEventListener("keydown", this.onKey);
  }
  hostDisconnected() {
    window.removeEventListener("keydown", this.onKey);
  }
  setQuery(value: string) {
    this.query = value;
    this.host.requestUpdate();
  }
  private onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.setQuery("");
  };
}
```

```ts
// After: signals drive updates; setup and teardown live together.
function createFilter() {
  const [query, setQuery] = createSignal("");
  onSettled(() =>
    listen(window, "keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") setQuery("");
    }),
  );
  return { query, setQuery };
}
```

A copied value becomes a derivation, and a hand-built class string becomes the
array form:

```tsx
// Before
const [label, setLabel] = createSignal("");
createEffect(
  () => props.count,
  (count) => setLabel(t("items", { count })),
);
return <span class={`badge ${props.muted ? "badge--muted" : ""}`}>{label()}</span>;

// After
const label = () => t("items", { count: props.count });
return <span class={["badge", { "badge--muted": props.muted }]}>{label()}</span>;
```
