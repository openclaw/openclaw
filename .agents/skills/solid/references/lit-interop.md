# Lit interop (until the last Lit file is gone)

## One implementation per registered tag

A Solid component must never render a tag that a Lit class still registers. The browser upgrades the element to the Lit class, and Lit renders over Solid's children. So when you port an OpenClaw custom element:

1. Write the Solid component that renders the host tag.
2. Delete the Lit class and its `customElements.define` in the **same PR**.
3. Let remaining Lit callers reach the Solid version through the bridge.

Stateless Lit template helpers (functions returning `html` with no lifecycle, e.g. icon templates) may exist in both renderers until their last Lit caller is ported. Then delete the Lit original.

## The bridge: native hosts for Solid

`defineSolidBridge(tag, content, spec)` in `ui/src/lit/solid-bridge.ts` registers an `HTMLElement` that mounts the Solid component in its own light DOM. Its public API serves both imperative custom-element callers and Solid components. Remaining Lit callers can still use the same tag during the content migration:

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

The bridge preserves these contracts; `solid-bridge.test.tsx` exercises native and Solid entry points:

- **Properties and attributes:** properties set before upgrade are captured; declared properties mirror into props; attributes convert by declared or default type; `reflect` writes primitives back.
- **Commit timing:** imperative property updates batch, and the host's `updateComplete` resolves after synchronous Solid output commits. Solid-owned hosts participate in their parent's render cycle.
- **Child content:** caller-owned nodes and markers move into Solid's `props.children` and retain their identity through later DOM updates and reconnects, including named tooltip slots.
- **Moves and disconnects:** a move within one task keeps the root (the live sidebar depends on this); a real disconnect disposes it.
- **Context:** the bridge requests application context through the native `context-request` event and provides it as `ApplicationProvider`. A context replacement remounts the subtree; no Lit context provider is installed.
- **Solid callers:** the returned component renders the same tag as a Solid-owned host that is never double-mounted, and context flows through the nested root.

Keep the bridge's public API and existing native tag contracts at the Lit cutover. Retire its temporary template adapters after their last production callers are ported.

Before retaining an adapter, trace its production callers. If all callers are Solid and no native custom-element API remains, import the component directly and delete the bridge registration, legacy facade, and coupled tests. Preserve lazy imports during that cutover. A native tag with an existing imperative contract (such as the lazy tooltip host) is still a real boundary; do not remove it just because its content renders with Solid.

## Lit inside Solid

An unported Lit element inside a Solid tree is just a custom element: render its tag, set properties with `prop:`, and listen with camelCase or dashed `on…` handlers. Never let Solid and Lit both own the same DOM children. The Lit element gets its own host node.

Stateless legacy templates use `LitContent` and `solidContent` from
`ui/src/lit/solid-content.tsx`. That module owns their retained ranges, mounting,
connection, and cleanup; `mountLitContent` also serves imperative markdown media
slots. Native views use this boundary and its `emptyLegacyContent` sentinel
instead of importing Lit. The ratchet exempts this one interop module, not other
new files in its directory. Delete the module and its exception with the final
legacy-template cutover.

`LitContent` is for actual legacy templates, not a wrapper around Solid JSX. Remove it when its last legacy producer is ported, along with newly unused template helpers (check production Knip). Keep xterm, noVNC, markdown reconcilers, and canvas DOM islands as ref-owned native nodes: Solid owns the host and cleanup, while the island owns its descendants. A DOM island does not itself justify keeping Lit.

## The Lit ratchet

`scripts/check-control-ui-lit-ratchet.mts` (run by `check:changed` and `run-lint`) **reports** Lit metrics for every change. It never blocks growth inside existing Lit files: feature work in unported pages must keep landing. At most it rejects a brand-new Lit production file under `ui/src`, because new UI can be written in Solid and mounted from Lit through the bridge. See [lessons](lessons.md) for why it started advisory.
