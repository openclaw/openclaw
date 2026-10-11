# Lit interop (until the last Lit file is gone)

## One implementation per registered tag

A Solid component must never render a tag that a Lit class still registers. The browser upgrades the element to the Lit class, and Lit renders over Solid's children. So when you port an OpenClaw custom element:

1. Write the Solid component that renders the host tag.
2. Delete the Lit class and its `customElements.define` in the **same PR**.
3. Let remaining Lit callers reach the Solid version through the bridge.

Stateless Lit template helpers (functions returning `html` with no lifecycle, e.g. icon templates) may exist in both renderers until their last Lit caller is ported. Then delete the Lit original.

## The bridge: Solid inside Lit

`defineSolidBridge(tag, content, spec)` in `ui/src/lit/solid-bridge.ts` registers the tag as a minimal non-Lit element that mounts the Solid component in its own light DOM. Lit callers stay unchanged:

```ts
export const Tooltip = defineSolidBridge(
  "openclaw-tooltip",
  (props, host) => <TooltipView text={props.text} anchor={host} />,
  {
    properties: { text: { default: "" }, open: { default: false, reflect: true } },
    methods: { show: (host) => host.setAttribute("data-open", "") },
  },
);
```

What the bridge guarantees (all covered by `solid-bridge.test.tsx`):

- **Properties and attributes:** properties set before upgrade are captured; declared properties mirror into props; attributes convert by declared or default type; `reflect` writes primitives back.
- **Commit timing:** a property write commits Solid DOM and `flush()`es in a microtask, before a Lit parent's `updateComplete` resumes. It never flushes inside a Solid callback.
- **Child content:** caller-provided children (including Lit's part markers) move into Solid's `props.children` and keep working when the Lit caller re-renders.
- **Moves and disconnects:** a move within one task keeps the root (the live sidebar depends on this); a real disconnect disposes it.
- **Context:** the bridge requests the application context through the `@lit/context` protocol event and provides it as `ApplicationProvider`. A context replacement remounts the subtree.
- **Solid callers:** the returned component renders the same tag as a Solid-owned host that is never double-mounted, and context flows through the nested root.

The bridge is interim. It and its exact-path ratchet exception die with the last Lit caller.

Lifecycle-only providers use `preserveChildren: true`: their Solid effects run in a detached render root while Lit keeps its live children in place. This avoids disconnecting an already-mounted app shell to render a provider that has no visual output. Direct Solid callers still render their children normally.

## Lit inside Solid

An unported Lit element inside a Solid tree is just a custom element: render its tag, set properties with `prop:`, and listen with camelCase or dashed `on…` handlers. Never let Solid and Lit both own the same DOM children. The Lit element gets its own host node.

## The Lit ratchet

`scripts/check-control-ui-lit-ratchet.mts` (run by `check:changed` and `run-lint`) **reports** Lit metrics for every change. It never blocks growth inside existing Lit files: feature work in unported pages must keep landing. At most it rejects a brand-new Lit production file under `ui/src`, because new UI can be written in Solid and mounted from Lit through the bridge. See [lessons](lessons.md) for why it started advisory.
