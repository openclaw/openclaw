# Route transition remount census

The engines harness can measure every ordered pair of native routes, plus legacy
aliases and moved-section links, while reusing one document per source route:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --route-transitions --engines chromium --viewport desktop --remount-audit \
  --output .artifacts/remount-counts
```

This is a diagnostic pass against the production bundle and synthetic Gateway.
The separate `*.transitions.json` files record each source, requested destination,
application readiness time, and remount evidence. A failed transition is retained
with a screenshot and fails its source scenario; it is not a zero-remount result.
Plugin and Workboard merge their native resource fixture into the matrix, including
the first 100 loaded cards of a 1,000-card board, with its visible window rendered. The route catalog is recorded
in the harness manifest.

`--remount-audit` also works with existing `--steps`, including split panes,
drawers, session changes, and reconnect scenarios. It observes physical DOM
attachments and captures subtrees before destructive DOM operations, including
open shadow roots. Results separate same-node moves, identical-markup replacement
subtrees, and new transient content removed before settlement. Scope counts cover
the shell, sidebar, composer, transcript and page hosts, including descendants of
a detached ancestor. These are DOM attachment counts, **not Solid owner disposal
counts**. An identical markup match does not establish preserved draft, focus,
scroll or domain identity; inspect the owner before changing a lifetime.

Detailed snapshots are bounded to 512 operations and 256 KiB per subtree.
`truncated: true` means matching and transient details are incomplete; aggregate
scope, subtree and element counts continue. Reproduce a suspicious transition on
its own before drawing a conclusion. Snapshots are kept in-page; output includes
labels and counts rather than raw markup.

Run CPU and timing separately, with the probe disabled. The probe's DOM snapshots
and synchronous mutation delivery perturb the measured work. For example:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --steps remount-from-new-session \
  --transition-targets /settings/model-setup \
  --engines chromium,webkit,firefox --viewport desktop --pairs 20 \
  --output .artifacts/remount-timing
```

`--transition-targets` accepts exact comma-separated requested paths, including
query strings. `applicationMs` measures navigation to complete content readiness
inside the browser. `wallMs` includes automation and collection; Chromium CPU
uses `threadTicks`. Firefox and untraced WebKit have no CPU measurement, not zero
CPU. Use the existing `--cpu-profile` or `--trace` in a separate targeted run for
source attribution. Compare a candidate with `--compare-bundle-dir` and a matched
`--control-bundle-dir` A/A control before claiming a performance win.
