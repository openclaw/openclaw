---
name: solid
description: Write, port, review, or test Solid 2 UI in OpenClaw (Control UI, plugin views, Canvas hosts), including state ownership, Lit interop during the migration, native overlays, testing, performance, and lessons learned.
---

# Solid 2 in OpenClaw

The Control UI, plugin views (`extensions/x`, `extensions/workboard`), and the Canvas A2UI hosts render with **Solid 2** (`solid-js`, `@solidjs/web`, `@solidjs/signals`, compiled by `@solidjs/vite-plugin`/`@solidjs/compiler`). Lit 3 and Web Awesome are being removed. Until the last Lit file is gone, ported Solid code runs next to unported Lit at every commit.

Read [ui/AGENTS.md](../../../ui/AGENTS.md) first; its state-ownership rules apply to Solid unchanged. Use the exact installed Solid pins from the owning `package.json`: the runtime and compiler are `2.0.0-rc.14`, and `@solidjs/vite-plugin` is `3.0.0-next.49`. `solid-js` and `@solidjs/*` are exempt from the repository's seven-day release-age gate (Peter, 2026-10-11); third-party Solid ecosystem packages remain subject to it.

## Rules that keep the UI correct

1. **Domain owners stay plain TypeScript.** The Gateway store, capabilities, `lib/sessions/*`, caches, persistence, and mutation authority keep synchronous mutate-then-read semantics. Solid 2 writes become visible only after a microtask flush, so authoritative state never lives in a signal. → [state and ownership](references/state-and-ownership.md)
2. **Components consume projections** from `ui/src/lib/reactive/` (one per owner and scope, never a second store) and `useApplication()` for the application context.
3. **Host tags and classes survive.** A component renders its existing `openclaw-*` tag as a plain host element in light DOM; CSS and E2E select it. Never rename a tag or a class. → [components](references/components.md)
4. **One implementation per registered tag.** A Solid component must never render a tag that a Lit class still registers. When you port a custom element, delete its Lit class; remaining Lit callers reach the Solid version through `defineSolidBridge`. → [Lit interop](references/lit-interop.md)
5. **One renderer per DOM region**, and one lifecycle owner per overlay surface. → [overlays](references/overlays.md)
6. **Derive, don't synchronize.** `createMemo` before `createSignal`; no copies of owner state; no defensive guards for states the owner already excludes. Prefer smaller code than the Lit you replace.

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
- Events are **camelCase** (`onClick`). `onWaSelect` listens to `waselect`; dashed custom events need `onWa-select` or a `listen(...)` ref factory.
- A read right after a write sees the **old** value until `flush()`. Don't write-then-read in handlers; derive.
- Reactive reads after the first `await` in an async memo are untracked, and async memos get no `AbortSignal`.
- Ref callbacks run **unowned**: `onCleanup` inside them does nothing.
- ARIA enumerations are typed strings: `aria-pressed={pressed() ? "true" : "false"}`, never a boolean.
- Solid 1 APIs (`createResource`, `onMount`, `mergeProps`, `Context.Provider`) don't carry over: use async computations, `onSettled`, `merge`, and the context component itself.

More, each with its root cause: [lessons learned](references/lessons.md).

## Testing

`mountSolid`, `waitForSolid`/`flush`, `renderSolidRef`, and the Solid application-context provider live in `ui/src/test-helpers/`. `.test.tsx` files are discovered. Keep assertions when you replace a harness. Visual changes need `pnpm ui:parity` or inspected before/after screenshots. → [testing](references/testing.md)

## References

| Topic                                                    | Read when                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [components](references/components.md)                   | porting or writing components: Lit → Solid table, JSX bindings, events, refs, styles |
| [state and ownership](references/state-and-ownership.md) | touching owners, projections, async reads, lifetimes, parking, chat render lifecycle |
| [Lit interop](references/lit-interop.md)                 | a Lit caller uses your component, or your component hosts unported Lit               |
| [overlays](references/overlays.md)                       | menus, popovers, tooltips, dialogs, focus, positioning, the platform floor           |
| [testing](references/testing.md)                         | unit, browser, E2E, WebKit, parity, retention suites                                 |
| [performance](references/performance.md)                 | startup bundle, lazy loading, render budgets                                         |
| [plugins](references/plugins.md)                         | building a plugin's Control UI view in Solid                                         |
| [migration](references/migration.md)                     | porting the remaining Lit, the final sweep, the inventory                            |
| [lessons learned](references/lessons.md)                 | before a new kind of change; most entries cost a failed CI run to learn              |
