---
name: control-ui-solid
description: Port or review OpenClaw Control UI code moving from Lit 3 and Web Awesome to Solid 2, including components, projections, lifecycle boundaries, and migration proof.
---

# Control UI on Solid 2

The Control UI is migrating from Lit 3 + Web Awesome to Solid 2. Each lane lands its own focused PR on `main`; the plan and lane assignments live with the migration coordinator. Read [ui/AGENTS.md](../../../ui/AGENTS.md) and the assigned work order first. Ported Solid code runs next to unported Lit at every commit; Lit and Web Awesome are removed once the last caller is ported.

Use the exact installed Solid 2 pins and APIs in the owning package manifests. Add dependencies only within the work order; keep the seven-day release-age gate and coordinated package upgrades. The helpers, lint rules, and codemod below describe the migration target: check that the owning lane has landed before using them. If a prerequisite is still in flight, keep porting what doesn't need it, poll `origin/main`, and merge it when it lands; don't end your session to wait. A fix in another lane's files is the smallest named interface change, recorded in your PR.

## Architecture you must keep

- **Domain owners stay plain TypeScript.** Gateway store, capabilities, `lib/sessions/*` (reconciler, provenance, refresh coordinator), caches, persistence, and mutation authority keep synchronous mutate-then-read semantics. Never move authoritative state into a Solid signal: Solid 2 setters become visible only after a microtask flush.
- **Projections in `ui/src/lib/reactive/` publish what owners admitted.** One per owner and scope, never a second store. Preserve initial reads, subscriptions, equality contracts, and explicit disposal. Mutable snapshots publish a revision signal. Event channels (invalidations, confirmations, handoffs, Gateway events) stay events.
- **Lifetimes are explicit:** application → connection/presentation scope → session/pane → view. _Retained, presented, retiring,_ and _disposed_ are different states. Hidden retained surfaces stay mounted and read parked projections, frozen while hidden and caught up on reveal. Iframe/MCP teardown has an awaited retiring phase before DOM removal.
- **Stale-result rules from `ui/AGENTS.md` still apply.** Key async reads by complete connection, agent, session, and query identity. Async memos discard superseded results but get no AbortSignal; keep generation guards around shared caches and Gateway writes. For immediate transport cancellation, use an owned async-iterable adapter whose `return()` aborts. Cancellation is never rollback. `action` and optimistic stores present mutations; captured targets, live authority, and uncertain outcomes stay with the domain owner.
- **Route loaders stay in the router.** Preserve pending-module retention, loader-pending rendering, retained Chat, and connection-scope retirement through the router adapter.
- **Commit is not layout settlement.** Use the shared `RenderLifecycle.afterCommit` contract for committed DOM; geometry still settles through requestAnimationFrame/ResizeObserver. Keep one live sidebar and stable retained pane/iframe nodes.

## Conversion playbook

| Lit                                     | Solid 2                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| element class + `customElements.define` | `function X(props)` rendering the existing `<openclaw-x>` host tag (CSS and E2E select it)                                                                                   |
| `@property() foo`                       | `props.foo`; **never destructure props**; `merge` for defaults (`undefined` overrides), `omit` for a remainder                                                               |
| `@state()`                              | `createMemo` derivation first; `createSignal` only for genuinely local state                                                                                                 |
| `willUpdate`                            | `createMemo` / function-form `createSignal`                                                                                                                                  |
| `updated()`                             | `createEffect(compute, apply)`; apply runs after DOM commit; return cleanup from apply                                                                                       |
| `firstUpdated`                          | `onSettled` (one-shot; return cleanup, no reactive primitive creation or `flush()` inside)                                                                                   |
| `connected`/`disconnectedCallback`      | component body / `onCleanup`                                                                                                                                                 |
| `requestUpdate()`                       | delete it                                                                                                                                                                    |
| `html`/`svg` templates                  | JSX                                                                                                                                                                          |
| `cond ? html\`…\` : nothing`            | `<Show when>` or a ternary; `nothing` in attributes → `undefined`                                                                                                            |
| `.prop=${v}`                            | `prop:prop={v}` preserves explicit property assignment on native and custom elements; ordinary JSX works only for the renderer's recognized stateful properties              |
| `?disabled=${b}`                        | `disabled={b}` (ARIA enumerations need `"true"`/`"false"` strings)                                                                                                           |
| `@click=${fn}`                          | `onClick={fn}`: **camelCase**; lowercase `onclick` becomes an attribute string                                                                                               |
| `@some-event=${fn}`                     | `onSome-event={fn}` or `ref={listen("some-event", fn, opts)}`                                                                                                                |
| `repeat(items, key, tpl)`               | `<For each={items} keyed={key}>` (item and index are accessors)                                                                                                              |
| `keyed(k, tpl)`                         | `<Show when={k} keyed>` only for truthy identities; it hides falsy keys that Lit would render. Preserve every valid identity and explicit reset; never key by streaming text |
| `guard(deps, fn)`                       | Equality-gated dependency memo feeding an untracked render computation; preserve every explicit dependency and parked-work gate                                              |
| `live(v)`                               | `liveValue` ref factory: compare the DOM value before writing                                                                                                                |
| `ref()`                                 | `ref={el}` or a callback (unowned: no cleanup inside)                                                                                                                        |
| class strings / `classMap`              | `class={["a", { b: cond }]}`                                                                                                                                                 |
| `styleMap`                              | `style={{ … }}`                                                                                                                                                              |
| `unsafeHTML(sanitized)`                 | the shared sanitized-HTML helper only                                                                                                                                        |
| `until`                                 | async `createMemo` + `<Loading>`                                                                                                                                             |
| `@consume`                              | `useApplication()`                                                                                                                                                           |
| `@lit/task`                             | async `createMemo` + `isPending`/`refresh`, or an explicit owner if it has side effects                                                                                      |
| `ReactiveController`                    | `useX()` primitive with owner cleanup; extract domain logic first                                                                                                            |
| custom directive                        | ref directive factory (behavior) or component (content owner)                                                                                                                |
| `t("key")`                              | unchanged; it reads the locale revision signal                                                                                                                               |

The planned codemod (`scripts/codemods/lit-to-solid.mts`) handles mechanical bindings and leaves `TODO(solid2): <reason>` markers for ownership decisions. Resolve every marker before handoff; the migration lint gate must reject them. Do not mechanically convert `keyed`, `live`, `guard`, `cache`, custom directives, unsafe HTML, controller lifetimes, or cancellation.

Render light DOM under the existing host tag. Scope former shadow styles to that host; replace `:host`, slots, and Web Awesome `::part` selectors deliberately. Keep the shared stylesheet policy. Use `jsxImportSource: "@solidjs/web"` and its JSX types, not Solid 1's `solid-js/web` or JSX namespace.

## Traps that compile but break

- `on:x={…}`, `attr:x`, `bool:x`, `classList`, and `use:` compile to literal attributes or no-ops in Solid 2. Lint flags them.
- `onWaSelect` listens to `waselect`. Dashed events need `onWa-select` or `listen(...)`.
- Reads after a write see the old value until `flush()`. Don't write-then-read in handlers; derive.
- Reactive reads after the first `await` in an async memo are not tracked.
- A memo's `equals` compares results after computation; it does not replace Lit `guard`'s check before rendering. Compare the explicit dependency vector element by element in a dependency memo, then read that memo from a separate computation and invoke `untrack(fn)`. An equivalent owner-controlled gate is also valid. Hidden data must not become a new rendering dependency for parked content.
- Ref callbacks run without an owner, so `onCleanup` inside them does nothing. Create reactive work and register cleanup in the ref factory's owned setup or component body. For one-shot settled DOM work, return cleanup from `onSettled`.
- Nonkeyed `Show` callback children get accessors; keyed children get raw values. Calling a branch accessor after its branch unmounted throws.
- Solid 1 APIs such as `createResource`, `onMount`, `mergeProps`, and `Context.Provider` do not carry over. Use async computations, `onSettled`, `merge`, and the context component itself.
- `action` uses a generator: `yield` restores transaction context; `await` alone does not.
- Proxies and stores break `WeakMap` identity caches. Keep immutable message/tool objects out of stores.
- Never let two renderers own the same DOM children (an unported Lit element inside Solid gets its own host node).

## Overlays (Web Awesome replacements)

Target floor: Safari/WebKit 26.2, Chrome/Edge and Firefox from the last ~6 months. The floor and capability enforcement land before the native-first overlays that depend on them. Linux WebKitGTK qualification remains a coordinator prerequisite.

- **Positioning:** CSS anchor positioning (`anchor-name`, `position-area`, `position-try-fallbacks`). No Floating UI. Caret popups anchor to an invisible element placed at the measured caret.
- **Top layer and light dismiss:** use popovers for nonmodal overlay surfaces so they stay usable inside `<dialog>.showModal()`. `auto` supplies native light dismissal; `manual` needs the owning dismissal policy. Do not create competing native and library dismissal owners.
- **Dialogs:** native `<dialog>` under the existing modal policy (focus entry/return, cancellation, native occlusion leases).
- **Menus:** the shared Solid `<Menu>` on the qualified headless engine; Zag is the plan's first candidate, with a Solid 2 adapter and roving-focus/cancellation parity still requiring proof. Never hand-roll keyboard models or silently substitute an unqualified engine.
- **Ownership:** one overlay lifecycle owner per surface (opening/open/closing/hidden; cancellation decided before listeners, inertness, occlusion, or focus change; completion never published for a superseded transition).
- **Native occlusion** (`ui/src/lib/native-overlay-occlusion.ts`) still applies; top layer does not cover native views.
- Preserve prompt usable-state focus, newer user focus, native Tab exit, nested Escape, vetoed transitions, and synchronous rollback of rejected controlled values. Exercise close/reopen, late veto, disconnect/remount, and native overlap during closing; settled screenshots cannot prove these races.

## Tests

- Use `mountSolid(() => view, options)` from `ui/src/test-helpers/mount-solid.ts`; it returns scoped queries, `container`, and an idempotent `unmount()`. Roots dispose after each test and before shared-worker reset. Explicit `unmount()` supports teardown assertions; caller-supplied containers remain, while helper-created containers are removed.
- Use `createSolidApplicationContextProvider(context)` from `solid-application-context.tsx` as the mount's `wrapper`. It shares the Lit harness's Gateway snapshot/event fixtures. `setContext(next)` retires and remounts consumers under the new provider; unmounting consumers never disposes the application capabilities.
- Import `flush` and `waitForSolid` from `solid-settle.ts`. Flush synchronous signal writes; await an observable assertion with `waitForSolid(() => expect(...))` for async outcomes. `flush()` does not settle promises or browser layout. Retained Lit children still need their own `updateComplete` boundary; `components/option-card.test.ts` demonstrates this mixed-renderer harness.
- Use `renderSolidRef(() => ref, { targetElement, ...options })` from `render-solid-ref.ts` for ref behaviors. It forwards container/wrapper/query/hydration options that Testing Library beta.3 drops. Create effects and cleanup in the owned factory; the returned ref callback runs unowned.
- Follow [test authoring](../../../docs/help/testing/writing-tests.md) and [test-audit](../test-audit/SKILL.md) when changing tests. Record focused wall time and CI seconds in the PR; preserve TSX test discovery and owner routing.
- Keep assertions; replace harness. Delete tests only when the behavior they protect is gone.
- The quantitative chat gates (zero textarea writes, constant stream work, retained identity, heap/idle budgets, zero removed markdown nodes) and the `WeakRef` + `collectGarbageForTest` suites must stay green.
- Follow [OpenClaw testing](../openclaw-testing/SKILL.md) and [Crabbox](../crabbox/SKILL.md). Migration suites, typechecks, changed checks, builds, and E2E go to Testbox via `node scripts/crabbox-wrapper.mjs`: one task-owned lease, stopped at handoff. Quick single-file tests may run locally when a remote round trip costs more than it saves. No local Docker/OrbStack.

## Proof per port

Use the work order's scoped proof for additive foundations or docs-only lanes. For rendered ports, preserve existing budgets and collect:

- touched unit/browser/E2E suites
- the visual parity diff against `main`
- Solid lint and `tsgo`
- Node and Bun lanes for touched tests
- WebKit for overlay/focus code
- no `TODO(solid2)`
- the inventory shrinks and the ratchet passes

Run [Codex autoreview](../autoreview/SKILL.md), resolve actionable findings, and follow the work order's publication boundary. Open a ready PR against `main` and land it through the native `scripts/pr` workflow once exact-head CI and ClawSweeper are green or every remaining failure is attributed to the base; never arm auto-merge. Report branch/HEAD, grouped files, exact proof commands/results and lease/run IDs, requested calibration, open questions, and stopped lease status.
