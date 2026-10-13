# Components

## Shape

- A component is `function X(props)` that renders its existing `openclaw-*` host tag as a plain element in **light DOM**. CSS (181 tag selectors) and E2E (about 2,000 tag selectors) select those tags, so never rename a tag or a class.
- Former shadow styles are scoped to the host tag. Replace `:host`, slots, and Web Awesome `::part` selectors deliberately; keep the shared stylesheet policy in `ui/AGENTS.md`.
- A registered OpenClaw custom element has exactly one implementation. See [Lit interop](lit-interop.md) for how remaining Lit callers reach a Solid component.
- Keep components small and boring: props in, projections and `useApplication()` for state, JSX out. Extract domain logic to the owner before porting a controller.

## Lit → Solid 2

| Lit                                     | Solid 2                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| element class + `customElements.define` | `function X(props)` rendering the existing `<openclaw-x>` host tag                                             |
| `@property() foo`                       | `props.foo`; **never destructure props**; `merge` for defaults (`undefined` overrides), `omit` for a remainder |
| `@state()`                              | a `createMemo` derivation first; `createSignal` only for genuinely local state                                 |
| `willUpdate`                            | `createMemo`, or function-form `createSignal`                                                                  |
| `updated()`                             | `createEffect(compute, apply)`; `apply` runs after the DOM commit and returns cleanup                          |
| `firstUpdated`                          | `onSettled` (one-shot; return cleanup; no reactive primitives or `flush()` inside)                             |
| `connected`/`disconnectedCallback`      | the component body / `onCleanup`                                                                               |
| `requestUpdate()`                       | delete it                                                                                                      |
| `html`/`svg` templates                  | JSX                                                                                                            |
| `cond ? html\`…\` : nothing`            | `<Show when>` or a ternary; `nothing` in attributes → `undefined`                                              |
| `.prop=${v}`                            | `prop:prop={v}` for explicit property assignment on native and custom elements                                 |
| `?disabled=${b}`                        | `disabled={b}`; ARIA enumerations need `"true"`/`"false"` strings                                              |
| `@click=${fn}`                          | `onClick={fn}`: camelCase; lowercase `onclick` becomes an attribute string                                     |
| `@some-event=${fn}`                     | `onSome-event={fn}` or `ref={listen("some-event", fn, opts)}`                                                  |
| `repeat(items, key, tpl)`               | `<For each={items} keyed={key}>` (item and index are accessors)                                                |
| `keyed(k, tpl)`                         | `<Show when={k} keyed>` only for truthy identities; never key by streaming text                                |
| `guard(deps, fn)`                       | an equality-gated dependency memo feeding an untracked render computation (see [lessons](lessons.md))          |
| `live(v)`                               | the `liveValue` ref factory: compare the DOM value before writing                                              |
| `ref()`                                 | `ref={el}` or a callback (unowned: no cleanup inside)                                                          |
| class strings / `classMap`              | `class={["a", { b: cond }]}`                                                                                   |
| `styleMap`                              | `style={{ … }}`                                                                                                |
| `unsafeHTML(sanitized)`                 | the shared sanitized-HTML helper only                                                                          |
| `until`                                 | async `createMemo` + `<Loading>`                                                                               |
| `@consume`                              | `useApplication()`                                                                                             |
| `@lit/task`                             | async `createMemo` + `isPending`/`refresh`, or an explicit owner if it has side effects                        |
| `ReactiveController`                    | a `useX()` primitive with owner cleanup; extract domain logic first                                            |
| custom directive                        | a ref directive factory (behavior) or a component (content owner)                                              |
| `t("key")`                              | unchanged call shape; import `t` from `lib/reactive/i18n.ts`                                                   |

Don't convert `keyed`, `live`, `guard`, `cache`, custom directives, unsafe HTML, controller lifetimes, or cancellation mechanically. Each encodes an ownership decision.

## Bindings and types

- `prop:` is the only surviving JSX namespace. `on:x`, `attr:x`, `bool:x`, `classList`, and `use:` compile to literal attributes or no-ops; lint rejects them.
- Custom tags with properties need typings: augment `@solidjs/web`'s `JSX.IntrinsicElements` in a `.d.ts` (see `ui/src/types/solid-elements.d.ts`). Keep that file a module with a side-effect `import "@solidjs/web";`. Lint forbids `export {}`, and without a module marker `declare module` silently becomes an ambient declaration instead of an augmentation. Inside the augmented `namespace JSX`, refer to `HTMLAttributes` unqualified.
- Native ARIA attributes are typed enumerations: `aria-pressed={on() ? "true" : "false"}`.
- Nonkeyed `Show` callback children receive accessors; keyed children receive raw values. Calling a branch accessor after its branch unmounted throws.
- Every new non-`const` type assertion needs a `// SAFETY: <invariant>` comment (assertion-safety ratchet). Prefer a real type.

## Async and effects

- Async memos discard superseded results but get no `AbortSignal`. Keep generation guards around shared caches and Gateway writes. For immediate transport cancellation, use an owned async-iterable adapter whose `return()` aborts. Cancellation is never rollback.
- Reactive reads after the first `await` are untracked: read everything you depend on first.
- `action` uses a generator: `yield` restores the transaction context; `await` alone does not.
- Proxies and stores break `WeakMap` identity caches. Keep immutable message and tool objects out of stores.

## Size

Port behavior faithfully with the simplest code that keeps the contract. No wrapper layers or helpers unless two callers need them. A port should land at or below the Lit LOC it replaces; if it doesn't, the PR explains why. Formatter-expanded JSX is the usual culprit: extract a subcomponent instead of nesting ternaries.
