# Solid 2 idioms

Use this when writing or auditing rendering consumers. The installed rc.14
`solid-js/CHEATSHEET.md`, `solid-js/types/client/flow.d.ts`, and
`@solidjs/signals/dist/types/` own the API contract; Solid 1 examples are not a
substitute. Examples below abbreviate code from the named OpenClaw modules.

## Replace rendering controllers

Replace a rendering controller with `createThing(deps)`, called inside the owning
component or Solid root. Return accessors and actions. Local interaction state
belongs in signals; structured local drafts belong in `createStore` with its
draft setter and `reconcile` for keyed updates. Derive values with `createMemo`,
never effects that copy state. Domain owners stay plain TypeScript; their
synchronous decisions do not become signals or stores.

Replace `hostConnected`/`hostDisconnected` with owner-scoped setup and cleanup in
the same function. Signals replace `requestUpdate`. For example, this local
disclosure replaces a controller's mutable `open`, key listener, and host update:

```ts
import { createMemo, createSignal, onSettled } from "solid-js";
import { listen } from "./listener.ts";

function createDisclosure(trigger: () => HTMLElement, label: () => string) {
  const [open, setOpen] = createSignal(false);
  const accessibleLabel = createMemo(() => `${label()}: ${open() ? "open" : "closed"}`);
  onSettled(() =>
    listen(trigger(), "keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setOpen(false);
      }
    }),
  );
  return { open, accessibleLabel, toggle: () => setOpen((value) => !value) };
}
```

Prefer JSX handlers. When native capture/options or an external target requires
an imperative listener, `lib/reactive/listener.ts` returns teardown for the
owning `onSettled` callback, split-effect apply phase, or explicit lifetime.
`lib/solid-native-listener.ts` remains the owned ref factory for native bubbling
through custom-element boundaries. Ref callbacks capture nodes; they must not
create cleanup registrations. Use refs instead of `querySelector`; retain
deliberate xterm, noVNC, PDF, and canvas islands as ref-owned regions.
JSX handlers can still fire on a detached node retained by another owner. Use
explicit listener teardown when late events could observe replacement props.

Remove `untrack` unless a read deliberately must not subscribe; explain
non-obvious snapshots. Delete the old controller, host adapter wiring, and
test-only exports together. Keep an adapter only while `git grep` shows real
callers. Tests assert public behavior and cleanup, not controller internals.

Keep routes, keyboard/focus behavior, tags, selectors, and lazy boundaries.
Keep each PR focused and reduce production LOC. When refactoring lifecycles,
report before/after controller-pattern references, `createEffect`, `untrack`,
native listener registrations, and LOC for touched production files.

## Choose the primitive

Start from the narrowest primitive that expresses the data's owner and lifetime:

| Data                                                                             | Primitive                                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Authoritative domain state (Gateway store, sessions, caches, mutation authority) | Plain TypeScript owner; never a signal. Read it through a projection.                                |
| An owner's snapshot in a view                                                    | `projectOwner`/`projectSource` (`lib/reactive/projection.ts`), narrowed with memos                   |
| A cheap value derived from props or signals                                      | An accessor `() => …` or a JSX expression                                                            |
| An expensive or shared derivation                                                | `createMemo` (with `equals` only for immutable values)                                               |
| Local interaction state (open, hovered, active tab)                              | `createSignal`                                                                                       |
| A local draft that resets or reconciles from a source                            | Writable derivation `createSignal(() => source())`, with the reset policy commented                  |
| Structured or keyed local state                                                  | `createStore` with draft setters; `reconcile(rows, "id")` for keyed lists                            |
| A keyed collection derived from async or owner data                              | `createProjection(fn, initial, { key: "id" })`                                                       |
| An expected value shown before a mutation settles                                | `createOptimistic`/`createOptimisticStore` inside `action`                                           |
| Count-only repetition                                                            | `<Repeat count={n}>`                                                                                 |
| Browser document title                                                           | `createDocumentTitle(title)` from `lib/reactive/document-title.ts`                                   |
| Resize notifications for owned elements                                          | `createResizeObserver(() => [element], callback)` from `lib/reactive/observers.ts`                   |
| Visibility notifications for owned elements                                      | `createIntersectionObserver(() => [element], callback, options)` from the same module                |
| Periodic work while a reactive cadence is enabled                                | `createInterval(callback, () => enabled() ? milliseconds : undefined)` from `lib/reactive/timers.ts` |
| Restartable event-driven delay or feedback reset                                 | `createTimeout(callback, milliseconds)`; call `schedule()` or `cancel()`                             |
| Browser media capability                                                         | `createMediaQuery(query, fallback)` from `lib/reactive/platform.ts`                                  |
| Document visibility                                                              | `createDocumentVisibility()` from `lib/reactive/platform.ts`; polling policy stays with its owner    |
| One owned pointer gesture                                                        | `createPointerDrag()` from `lib/reactive/pointer-drag.ts`; caller keeps geometry and commit policy   |

`createMemo(fn, { lazy: true })` defers the first computation until something
reads it and disposes it when nothing observes it; `createSignal(v, { unobserved })`
fires when the last subscriber leaves. Reach for them in new adapters that must
release upstream work with their last reader. Keep the existing `projectSource`
contract (read-through, revision equality, scope replacement) rather than
reimplementing it piecemeal.

## Derive values; effects perform work

A component body runs once. JSX bindings, memos, and effect compute phases track
reads; the component body, flow-component callbacks, and effect apply phases do
not. Put a cheap expression in JSX or an accessor. Use a memo when computation
is expensive, shared by multiple readers, or needs equality to stop unrelated
updates. Do not memoize every property access.

```tsx
// Don't: a second copy, an extra publication, and an effect scheduling dependency.
// formatForDisplay stands for the existing sanitized formatter.
const [markup, setMarkup] = createSignal("");
createEffect(
  () => props.value,
  (value) => setMarkup(formatForDisplay(value)),
);

// Do: derive markup once, as HighlightedJson does for SanitizedHtml.
const markup = createMemo(() => formatForDisplay(props.value));
return <SanitizedHtml tag="pre" html={markup()} />;
```

Use `createSignal` for local interaction state, such as whether a disclosure is
open. A writable derivation (`createSignal(() => source())`) fits a local draft
that deliberately resets or reconciles when its source changes. rc.14 re-derives
from the locally written previous value: explain the reset policy, rather than
using it to mirror owner state. Gateway decisions and synchronous domain state
remain in their existing TypeScript owners.

Split effects into tracked preparation and imperative application. For example,
`components/solid/tabs.tsx` collects options and items in compute, then calls the
plain tabs controller's `sync()` after DOM bindings. That controller integration
is an effect; calculating which tab is selected is a derivation.

```ts
createEffect(
  () => props.title,
  (title) => {
    element.title = title;
  },
);
```

An apply callback is untracked and unowned. Capture all reactive facts in
compute, return per-run cleanup from apply, and create primitives in the
component/factory body. Restore a captured owner with `runWithOwner` only when
an existing adapter must mount nested Solid content (see [lessons](lessons.md)).
Do not opt into `ownedWrite: true` just to make an effect-to-signal copy work.

## Props and events stay live

```tsx
// Don't: both freeze the initial prop value.
function Count({ value }: { value: number }) {
  return <span>{value}</span>;
}
const label = props.label;
const frozen = untrack(() => props.label);

// Do: keep the read at a tracking boundary.
const label = () => props.label ?? t("common.loading");
return <span>{label()}</span>;
```

Pass values at JSX boundaries (`value={count()}`), unless the prop's explicit
contract is an accessor or render callback. `merge(defaults, props)` and
`omit(props, "class")` preserve reactive forwarding; `undefined` in `merge`
overrides defaults. Do not spread props into a plain object in the component
body. A spread inside JSX remains reactive.

`untrack` declares an intentional snapshot, not a repair for a lint warning.
Use it for lifetime-stable identity or a read excluded from a derivation; name
why it should not update. For dynamic element selection, follow
`components/solid/markdown-html.tsx`: `dynamic(() => props.as ?? "div")`, without
snapshotting the tag first.

Native compiled event bindings bind once. Dispatch through the current prop
inside a stable callback when the parent may replace the handler:

```tsx
// Don't: chooses the initial native handler.
<button onClick={props.onRetry} />
// Do: LazyViewError dispatches to the live callback.
<button onClick={(event) => props.onRetry(event)} />
```

A local lifetime-stable function can be bound directly. Dynamic elements use
runtime prop spreads, which can update handlers; do not add wrappers solely for
that case. Native capture/options and events stopped by an enclosing native
boundary still need the owned listener/ref pattern. Dashed events use
`onWa-select`, not `onWaSelect`. Prefer the existing owned primitive to `wa-*`.

Commit-on-change inputs need special care: unrelated props refreshes must not
rewrite the DOM draft. Memoize the committed owner value before binding `value`
(see the Settings input incident in [lessons](lessons.md)). Do not use a second
signal to synchronize that value. Controlled inputs that publish every keystroke
have a different contract; preserve composition, caret, and undo behavior.

## Pair lifecycle setup with teardown

Use `onSettled` for one-time DOM-dependent setup and return cleanup from the same
block. It is not a recurring effect and its reads do not subscribe.

```ts
onSettled(() => {
  const stop = owner.subscribe(handleEvent);
  return stop;
});
```

For value-dependent setup, use a split effect whose apply returns cleanup. Feed
it through a memo if equal source refreshes must not cancel a timer or reconnect
a listener. `onCleanup` remains appropriate in custom primitives that register
an already-created resource's disposal, such as `lib/reactive/projection.ts`.
Do not mechanically move synchronous lifetime registration to a later settle.

Ref callbacks are unowned. Create effects and cleanup in an owned ref factory;
the returned ref only captures the node or performs DOM writes. Do not call
`onCleanup` or create projections inside the ref callback. In owner-backed
`onSettled`, prepare primitives before the callback and return cleanup: it forbids
nested `onCleanup`, primitive creation, and `flush()`. An event-handler
registration is a one-shot and must not return cleanup. Cleanup releases
resources without publishing new presentation state.

## Projections and local stores have different jobs

Reuse `projectOwner`/`projectSource` from `lib/reactive/projection.ts`
when consuming an owner's snapshot, rather than inventing revision signals and
subscribe/notify loops in each view. These adapters share observation, read
through synchronously, and release subscriptions with the view's owner. Mutable
snapshots require revision equality; object identity cannot detect in-place
mutations. Derive displayed fields narrowly from a projection.

Add a thin domain projection only with its first production caller. Event APIs
stay direct subscriptions with their original ordering and completion contract;
a latest-value signal loses deliveries. [State and ownership](state-and-ownership.md)
owns scope replacement and retained/parked presentation.

Use `createStore` for genuinely local structured drafts with field-level reads,
not for owner snapshots. Its setter mutates a draft:

```ts
setDraft((draft) => {
  draft.title = title;
});
// For an intentional local list reconciliation that preserves keyed identity:
setDraft((draft) => {
  reconcile(nextRows, "id")(draft.rows);
});
```

`createProjection` is Solid's readonly derived-store API; it is not OpenClaw's
owner adapter `projectSource`. Use it when a local derived structure benefits
from keyed reconciliation. Signals and store proxies are unnecessary for
immutable message/tool objects already used as WeakMap keys: preserve those raw
identities. Never serialize a store proxy as the authoritative data model;
`snapshot(store)` produces a plain presentation snapshot when needed.

## Key lists by the lifetime you intend

rc.14 callback arguments depend on `For`'s keying mode:

| Mode                        | Item          | Index    | Lifetime               |
| --------------------------- | ------------- | -------- | ---------------------- |
| default / `keyed={true}`    | raw value     | accessor | item identity          |
| `keyed={(item) => item.id}` | accessor      | accessor | semantic key           |
| `keyed={false}`             | accessor      | number   | position               |
| `Repeat count={n}`          | numeric index | —        | position, no list diff |

Use semantic keys for replaceable snapshots so rows retain DOM, focus, and local
state. `Tabs` and `SettingsSegmented` key options by `value` and read `item()`
inside JSX. Never capture `item().label` at the top of a callback: that body is
an owner, not a tracking computation. Default identity is useful for immutable
icon nodes; position is appropriate for anonymous skeleton slots, not sessions.
Streaming text, revision numbers, and array indices are not entity identities.

```tsx
// Do: replacing a row snapshot updates the same row component.
<For each={props.items} keyed={(item) => item.value}>
  {(item) => <span>{item().label}</span>}
</For>
```

Default `Show` preserves its branch across truthy values and passes a narrowed
accessor to function children. `Show keyed` passes a raw value and remounts on
identity change. Use the default when refreshing dialog data must retain local
state; use keyed only when changing the identity must retire the old work.
Neither renders a false/empty-string/zero identity. Never save a branch accessor
for use after its branch unmounts.

`CopyButton` deliberately uses default `<For each={[props.text]}>`: changing the
clipboard payload retires pending fallback/feedback, including for empty text.
Its tests prove replacement on payload change and preservation on label change.
Do not "simplify" that boundary to a persistent button or truthiness-based Show.

Use `Switch`/`Match` for several mutually exclusive rendering states when it
makes their ownership visible. A small scalar ternary is fine; changing syntax
alone is not a performance improvement. Review state preservation when replacing
control flow, not just the resulting markup.

## Async values and mutations

rc.14 has **no `createAsync` export**. Pure async reads are computations returning
a Promise or AsyncIterable. Read all reactive dependencies before the first
`await`; later reads are untracked.

```tsx
const details = createMemo(() => owner.readDetails(props.id));
return (
  <Errored fallback={(error, reset) => <button onClick={reset}>{String(error())}</button>}>
    <Loading fallback={<LoadingState />}>
      <Details value={details()} />
    </Loading>
  </Errored>
);
```

This illustrates a pure read contract, not permission to move admitted owner
requests into rendering. Keep connection/session/query identity, cancellation,
cache publication, and uncertain mutation outcomes at their existing owners.
Async memos drop superseded results but do not abort transport; retain explicit
cancellation where the owner requires it. Avatar loading and route loading have
existing owners: do not replace them merely to remove a loading flag.

Place `Loading` around the data-dependent slot, preserving surrounding chrome.
Once content has rendered, revalidation retains it. `on={identity()}` re-arms
fallback on dependency changes; it is not a key and does not remount children.
Keep all reads of that pending data under the boundary, or an outside hold can
prevent its fallback from appearing.

`isPending(() => details())` describes an in-flight value change, not every
network request. A bare `refresh(details)` re-asks the same question quietly;
`affects(details); refresh(details)` declares a reload that should read pending.
Do not call either from a pure read. A "saving" process indicator is a local
optimistic flag or an existing owner's mutation state, not inferred from every
read's pending status.

For presentation mutations, `action(function* (...) { yield ownerMutation(); })`
keeps Solid's transition context across async work; plain `await` does not.
`createOptimistic`/`createOptimisticStore` can display an expected value until
settlement, then reconcile with the owner. These APIs do not replace write
admission, rollback policy, target capture, or stale-result authority. Keep the
owner's visible error/retry outcome and catch async rendering errors with
`Errored` rather than an invented `.error` field on a read accessor.

## Context, components, and children

`createContext<T>()` without a default is the canonical form: `useContext`
returns `T` and throws `ContextNotFoundError` outside a provider, so don't add a
`useX()` wrapper whose only job is to rethrow. Use a default only for primitive
fallbacks (theme, locale). The context itself is the provider:
`<ThemeContext value={theme()}>`. App-wide state is not context: in OpenClaw it
lives in plain TypeScript owners reached through `useApplication()`.

Type components with `Component<P>`, `VoidComponent<P>`, `ParentComponent<P>`,
or `FlowComponent<P, C>`; renderer-neutral children are `Element` from
`solid-js`. Resolve children once with `children(() => props.children)` when a
component must inspect or reuse them; otherwise render `props.children`
directly.

## Classes, attributes, and refs

Compose classes with the array/object form,
`class={["badge", props.class, { "badge--muted": muted() }]}`. Never build
class strings with template literals, `.filter(Boolean).join(" ")`, or
concatenation: the array form keeps each condition reactive and composable.
Built-in attributes are lowercase (`tabindex`, not `tabIndex`); boolean
attributes are presence/absence (`muted={false}` removes it).

Refs are functions. Compose several with an array, `ref={[autofocus, tooltip(opts)]}`;
a bare `let el` inside that array is never assigned (that rewrite only works for
a single `ref`). Reusable DOM behavior is a two-phase directive factory: create
primitives in the owned setup phase, return an unowned callback that only
captures the node and writes to it.

## Dev diagnostics are bug reports

Treat these rc.14 dev warnings as real defects, not noise:

- **Top-level reactive read in a component body.** The body runs once. Read in
  JSX, a memo, or an accessor.
- **Write under an owned scope.** Writing a signal or store from a memo, an
  effect compute phase, or a component body throws in dev. `untrack` doesn't
  help, because the guard checks the owner, not tracking. Move the write to an
  event handler, `onSettled`, or effect apply, or derive instead of writing.
- **`STRICT_READ_UNTRACKED`.** A value read in an effect apply callback or at
  the top of a flow callback (`For`, `Show`, `Match`) is frozen. Read it in the
  compute phase, JSX, or a memo.
- **`LOADING_ON_OUTSIDE_HOLD`.** The same pending data is read outside the
  `Loading` boundary, so its fallback can never show. Move the read under the
  boundary.

`onSettled` also works inside an event handler: it defers follow-up work
(focus, measurement) until the transition that handler started has settled.

## Effects: the rare cases

`createEffect(compute, apply)` is the only effect form. Its options cover the
common edge cases without extra primitives: `{ defer: true }` skips the initial
run, and the object form `createEffect(compute, { effect, error })` routes
async failures to `error`, replacing Solid 1's `onError`/`catchError`.
`createRenderEffect` exists for render-phase bindings like the runtime's own;
feature code uses `createEffect`. `createTrackedEffect` and `createReaction` are
escape hatches for library internals, not for views.

## Tests

Reactive primitives need an owner: wrap ad hoc test code in
`createRoot((dispose) => …)` and dispose it. Call `flush()` before asserting on
a value you just wrote. For an async computation, `await resolve(() => value())`
waits for it to settle instead of polling. Assert snapshots of stores with
`snapshot(store)`, not the proxy.

## Audit and lint without fighting the contract

The V2 configuration lives in `.oxlintrc.json` with the plugin isolated under
`tools/solid-lint/`; `test/scripts/oxlint-solid.test.ts` proves rule selection.
Use the installed plugin's V2 rules, not its Solid 1 recommended preset.
Reactivity warnings need inspection: PascalCase data builders can be mistaken
for components, and imperative tests may intentionally read a committed value.
Name a real exception rather than adding a broad ignore or hiding a read with
`untrack`.

`solid/no-destructure` detects a real hazard, but plugin 0.18.1's defaults/rest
autofix still emits removed `mergeProps`/`splitProps`. Fix by hand with live props,
`merge`, or `omit`. Preserve deliberate client-wide projection singletons;
blanket `no-module-scope-reactive-primitive` enforcement rejects them.

Before changing a pattern, trace its owner and callers and name the failing
contract. Remove superseded paths and use one focused behavioral test when the
change affects identity, cleanup, or async work. [Performance](performance.md)
and [testing](testing.md) own the bundle and proof choices.
