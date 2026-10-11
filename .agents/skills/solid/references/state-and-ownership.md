# State and ownership

## Owners stay plain TypeScript

The Gateway store, capabilities, `lib/sessions/*` (reconciler, provenance, refresh coordinator), caches, persistence, and mutation authority keep **synchronous mutate-then-read** semantics. Solid 2 writes become visible only after a microtask flush (`flush()`), so a signal can't be an authoritative store: a caller that writes and immediately reads would see the old value. Components consume owners; they never become one.

## Projections

`ui/src/lib/reactive/` adapts owners to Solid (see its `README.md`):

- `projectSource(source, contract)` reads through to the synchronous owner, shares one upstream subscription across observers, releases it when the last observer leaves, and binds disposal to the creating Solid owner.
- Every adapter declares its equality contract. Mutable snapshots use `"revision"` (every owner notification publishes, including same-object mutations). Value comparators are only for immutable values. Never copy a mutable snapshot into a second writable store.
- Changing a connection, agent, session, or query means `replaceSource()` with a **new scope object**. Never mutate a scope in place.
- `projectEvents()` keeps synchronous, ordered delivery with duplicates and no replay. Invalidations, confirmations, handoffs, and Gateway events stay events, not latest-value signals.
- `useApplication()` (from `lib/reactive/context.ts`) returns the same capability object Lit consumers get. Providing it never transfers ownership.
- One projection per owner and scope. If you need data an owner doesn't publish, extend the owner, not the view.

## Lifetimes

Application → connection/presentation scope → session/pane → view. _Retained_, _presented_, _retiring_, and _disposed_ are different states:

- Hidden retained surfaces stay mounted and read **parked projections** (`createParkedProjection(read, presented)`): frozen while hidden, caught up once on reveal. Hidden data must never become a new rendering dependency of parked content.
- Iframe and MCP app teardown has an awaited retiring phase before DOM removal.
- Keep one live sidebar element (it moves between desktop and drawer) and stable retained pane and iframe nodes. Moving a node within one task must not dispose its Solid root.

## Async reads and stale results

The stale-result rules in `ui/AGENTS.md` apply. Key async reads by the complete connection, agent, session, and query identity. Async memos drop superseded results but get no `AbortSignal`, so generation guards stay around shared caches and Gateway writes. `action` and optimistic stores present mutations; captured targets, live authority, and uncertain outcomes stay with the domain owner.

## Router

Route loaders stay in the router. The Solid outlet preserves pending-module retention (cold fallback after 1 s; a loaded module keeps rendering while its loader is pending), the retained Chat page (hidden/inert/`aria-hidden` parking with `presented=false` propagation), and connection-scope retirement.

## Chat render lifecycle

Commit is not layout settlement. Chat components use the Solid render lifecycle (`ui/src/pages/chat/solid-render-lifecycle.ts`): commit generations, hidden-pane parking, and a separate layout-settlement phase. Geometry still settles through `requestAnimationFrame`/`ResizeObserver`. The chat gates are quantitative and encoded as tests:

- zero textarea setter writes during typing and undo/redo
- zero transcript `scrollHeight` reads across 10 keystrokes
- constant stream-only work for 20 vs 400 messages
- settled rows keep identity
- composer input ≤1 invalidation
- one render per settled width
- zero removed markdown nodes across streaming updates
- the three `WeakRef` retention suites

They must stay green at every step.

## Readiness facts for automation

`window.openclawControlUi` is the E2E/automation readiness contract. It is a **lazy getter**: the first read starts loading the readiness module and can return `undefined`. Automation must wait for it (`page.waitForFunction(() => window.openclawControlUi !== undefined)`) before a one-shot read. Product code never depends on it.
