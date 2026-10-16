# Components

## Shape

- A component is `function X(props)` that renders its existing `openclaw-*` host tag as a plain element in **light DOM**. CSS and E2E select those tags, so never rename a tag or a class.
- Scope component styles to its host tag and follow the stylesheet policy in `ui/AGENTS.md`.
- Keep components small: props in, projections and `useApplication()` for state, JSX out. Extract domain logic to its owner.

## Native custom-element hosts

`defineSolidBridge(tag, content, spec)` in `ui/src/lib/solid-bridge.ts`
registers a native custom element and returns its Solid component. Both entry
points use the same renderer. The content callback renders the **inside** of the
host; do not nest or independently render a raw registered tag from Solid. Use
the returned component so it marks its host as Solid-owned before refs run.

Keep declared properties, methods, host tags, classes, and event contracts stable.
Host property reads and writes are synchronous; `updateComplete` awaits committed
synchronous output, not async resources, layout, or animations. Caller children
belong to their own intact DOM range, rendered once in a stable outlet. Same-turn
moves retain the root; genuine disconnection disposes it at the microtask
checkpoint. See the full [native host contract](../../../../ui/src/lib/solid-bridge.md)
before changing property transport, content custody, connection, or context.

## Bindings and types

- Never destructure props: read `props.foo` where reactivity is needed. Use `merge` for defaults (`undefined` overrides) and `omit` for a remainder.
- `prop:` is the only surviving JSX namespace. Use `prop:value={value}` for explicit native or custom-element property assignment. `on:x`, `attr:x`, `bool:x`, `classList`, and `use:` compile to literal attributes or no-ops; lint rejects them.
- Native events use camelCase (`onClick`); dashed custom events keep their dash (`onSession-change`). Use a ref factory when native listener options are needed.
- Custom tags with properties need typings: augment `@solidjs/web`'s `JSX.IntrinsicElements` in a `.d.ts` (see `ui/src/types/solid-elements.d.ts`). Keep that file a module with a side-effect `import "@solidjs/web";`. Lint forbids `export {}`, and without a module marker `declare module` silently becomes an ambient declaration instead of an augmentation. Inside the augmented `namespace JSX`, refer to `HTMLAttributes` unqualified.
- Native ARIA attributes are typed enumerations: `aria-pressed={on() ? "true" : "false"}`.
- Nonkeyed `Show` preserves its branch across truthy values and passes an accessor; keyed `Show` remounts on identity change and passes a raw value. Neither accepts falsy identities. Calling a branch accessor after its branch unmounted throws. See [list and branch lifetimes](idioms.md#key-lists-by-the-lifetime-you-intend).
- Use `class={["base", { active: active() }]}` for reactive classes and `style={{ … }}` for styles.
- Every new non-`const` type assertion needs a `// SAFETY: <invariant>` comment (assertion-safety ratchet). Prefer a real type.

## Lifecycle and DOM ownership

Keep synchronous subscriptions in the component or factory body when descendants
can publish during setup, and pair teardown with `onCleanup`. Use `onSettled`
when setup needs committed DOM, and return its cleanup. Ref callbacks are unowned;
they capture nodes but cannot register cleanup.

Keep xterm, noVNC, markdown reconcilers, and canvas DOM islands as ref-owned native
nodes: Solid owns the host and cleanup, while the island owns its descendants.
Use the shared sanitized-HTML helper for HTML content. Read [idioms](idioms.md)
for tracked compute versus imperative apply, async computations with
`Loading`/`Errored`, and owner-backed mutations. Keep immutable message and tool
identities out of store proxies; preserve existing WeakMap caches.

## Size

Preserve behavior with the simplest code that keeps the contract. Add no wrapper
layers or helpers unless two callers need them. Refactors should reduce
production LOC; explain necessary growth. Formatter-expanded JSX is a common
source of growth: extract a subcomponent instead of nesting ternaries.
