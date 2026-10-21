---
name: solid
description: Write, refactor, review, or test Solid 2 UI in OpenClaw (Control UI, plugin views, Canvas hosts), including state ownership, native custom elements, overlays, testing, performance, and lessons learned.
---

# Solid 2 in OpenClaw

The Control UI and plugin views (`extensions/x`, `extensions/workboard`) render with **Solid 2** (`solid-js`, `@solidjs/web`, `@solidjs/signals`, compiled by `@solidjs/vite-plugin`/`@solidjs/compiler`). Lit and Web Awesome are removed from these surfaces; new code is Solid only. The Canvas hosts and A2UI v0.8 catalog also use Solid; the v0.9 catalog still uses the upstream renderer from `@a2ui/web_core`.

Read [ui/AGENTS.md](../../../ui/AGENTS.md) first; its state-ownership rules apply to Solid unchanged. Use the exact installed Solid pins from the owning `package.json`: the runtime and compiler are `2.0.0-rc.16`, and `@solidjs/vite-plugin` is `3.0.0-next.50`. `@solidjs/testing-library` remains `1.0.0-beta.3`. `solid-js` and `@solidjs/*` are exempt from the repository's seven-day release-age gate (Peter, 2026-10-11); third-party Solid ecosystem packages remain subject to it.

## Rules that keep the UI correct

**Before your first edit**, read the installed `ui/node_modules/solid-js/CHEATSHEET.md`, especially its "What changed from 1.x" list. It is the rc.16 API contract, written as a guard against React and Solid 1 priors, the two dominant bug sources. For new code or a Solid audit, then read [idioms](references/idioms.md) and [lessons](references/lessons.md); to refactor or review existing code, also use the [refactor checklist](references/refactor-checklist.md). Check `solid-js/types/client/flow.d.ts` and the installed `@solidjs/signals` / `@solidjs/web` types when choosing an API. rc.16 has no `createAsync`: asynchronous values are ordinary computations returning promises or async iterables. `createDeferred` explicitly permits stale answers during refetch; use it only when that lag is the intended presentation contract.

1. **Domain owners stay plain TypeScript.** The Gateway store, capabilities, `lib/sessions/*`, caches, persistence, and mutation authority keep synchronous mutate-then-read semantics. Solid 2 writes become visible only after a microtask flush, so authoritative state never lives in a signal. → [state and ownership](references/state-and-ownership.md)
2. **Components consume projections** from `ui/src/lib/reactive/` (one per owner and scope, never a second store) and `useApplication()` for the application context. Add a thin adapter only with its first production caller; subscribe to ordered events directly.
3. **Host tags and classes survive.** A component renders its existing `openclaw-*` tag as a plain host element in light DOM; CSS and E2E select it. Never rename a tag or a class. → [components](references/components.md)
4. **One implementation per registered tag.** Native custom elements and Solid callers share one renderer through `defineSolidBridge` in `ui/src/lib/solid-bridge.ts`. Use its returned component in JSX so the host has one lifecycle owner. → [components](references/components.md)
5. **One renderer per DOM region**, and one lifecycle owner per overlay surface. → [overlays](references/overlays.md)
6. **Derive, don't synchronize.** `createMemo` before `createSignal`; no copies of owner state; no defensive guards for states the owner already excludes. Prefer smaller code with fewer owners.
7. **Replace controller lifecycles at their owner.** Follow the [controller-to-Solid recipe](references/idioms.md#replace-rendering-controllers), including its worked example. Delete the class and host adapter wiring together; do not wrap a controller in revision signals as the final design.

## Component skeleton

An illustrative component (the tag is an example): it renders its host tag, reads an owner through a projection, and derives instead of copying state.

```tsx
import { createMemo, Show } from "solid-js";
import { useApplication } from "../lib/reactive/context.ts";
import { projectAgents } from "../lib/reactive/domain-capabilities.ts";

export function AgentCount(props: { compact?: boolean }) {
  const app = useApplication();
  // Reads through to the synchronous owner; disposed with this component's owner.
  const agents = projectAgents(app.agents);
  // Never destructure props: reads must stay reactive.
  const count = createMemo(() => agents.read().agentsList?.agents.length ?? 0);
  return (
    <openclaw-agent-count class={["agent-count", { "agent-count--compact": props.compact }]}>
      <Show when={count() > 0} fallback={<span class="muted">—</span>}>
        <span>{count()}</span>
      </Show>
    </openclaw-agent-count>
  );
}
```

Use `jsxImportSource: "@solidjs/web"` and its JSX types, not Solid 1's `solid-js/web`.

## Traps that compile but break

- `on:x`, `attr:x`, `bool:x`, `classList`, and `use:` are gone in Solid 2; they compile to literal attributes or no-ops (lint flags them). `prop:` is the only namespace left.
- Events are **camelCase** (`onClick`). Dashed custom events need the exact dash, such as `onSession-change`, or a `listen(...)` ref factory.
- Native event bindings bind once: dispatch through a stable callback that reads the current handler prop. Runtime spreads, including dynamic elements, can update handlers.
- A read right after a write sees the **old** value until `flush()`. Don't write-then-read in handlers; derive.
- Reactive reads after the first `await` in an async memo are untracked, and async memos get no `AbortSignal`.
- Ref callbacks run **unowned**: `onCleanup` inside them does nothing.
- ARIA enumerations are typed strings: `aria-pressed={pressed() ? "true" : "false"}`, never a boolean.
- Solid 1 APIs (`createResource`, `onMount`, `mergeProps`, `Context.Provider`) don't carry over: use async computations, `onSettled`, `merge`, and the context component itself.
- Writing a signal or store from a memo, an effect compute phase, or a component body throws in dev. `untrack` doesn't exempt it (the guard checks the owner); derive instead, or write from a handler, `onSettled`, or effect apply.
- Class strings built with template literals or `.filter(Boolean).join(" ")` lose composable reactivity: use `class={["base", { active: active() }]}`.
- `createRenderEffect` is for render-phase runtime bindings, and `flush()` in production code usually hides a write-then-read: feature code uses `createEffect` and derivations.

## Enforced wave-zero guard

`pnpm check:control-ui-controllers` runs in lint and the changed-file checks.
For production `ui/src`, it rejects `createRenderEffect` outside `lib/reactive/`,
all direct `addEventListener` calls in TSX, DOM queries outside the explicit
foreign-DOM owner list, and option-free memos whose callback only returns a
literal. Property/equality, async, and option-bearing memos retain their contracts.
Tests and test helpers are excluded. The native AST scan counts generic and
optional calls; `flush`, `getOwner`, and `runWithOwner` resolve actual Solid imports,
including aliases and namespaces, without counting owner methods or shadowed locals.

`createEffect`, `untrack`, `addEventListener`, `querySelector(All)`, `flush`,
`getOwner`, and `runWithOwner` also have
per-file shrink-only baselines in `config/control-ui-*-baseline.txt`. Deleting
calls requires `pnpm check:control-ui-controllers --prune`; moving an allowance
requires a verified Git rename. Never raise a baseline to admit new debt. See
the [refactor checklist](references/refactor-checklist.md) for replacements and
the permitted survivors.

More, each with its root cause: [lessons learned](references/lessons.md).

## Testing

`mountSolid`, `waitForSolid`/`flush`, `renderSolidRef`, and the Solid application-context provider live in `ui/src/test-helpers/`. `.test.tsx` files are discovered. Keep assertions when you replace a harness. Visual changes need inspected, sanitized before/after screenshots. Follow the assigned campaign's compute budget. → [testing](references/testing.md)

## References

| Topic                                                    | Read when                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [idioms](references/idioms.md)                           | choosing a primitive, derivations, props, lifecycle, stores, keys, async, context, diagnostics |
| [refactor checklist](references/refactor-checklist.md)   | refactoring or reviewing existing Solid: measurable smells, replacements, before/after         |
| [components](references/components.md)                   | writing components, native custom-element hosts, JSX bindings, events, refs, styles            |
| [state and ownership](references/state-and-ownership.md) | touching owners, projections, async reads, lifetimes, parking, chat render lifecycle           |
| [overlays](references/overlays.md)                       | menus, popovers, tooltips, dialogs, focus, positioning, the platform floor                     |
| [testing](references/testing.md)                         | unit, browser, E2E, WebKit, parity, retention suites                                           |
| [performance](references/performance.md)                 | startup bundle, lazy loading, render budgets                                                   |
| [plugins](references/plugins.md)                         | building a plugin's Control UI view in Solid                                                   |
| [lessons learned](references/lessons.md)                 | before a new kind of change; most entries cost a failed CI run to learn                        |
