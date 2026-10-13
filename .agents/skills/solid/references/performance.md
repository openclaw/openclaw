# Performance

## Startup bundle

The startup-JS budget (`scripts/check-control-ui-performance.mts`, baseline in `config/control-ui-startup-budget-baseline.json`) is enforced with a small growth tolerance. Budget changes need owner approval; fix the graph instead:

- Keep code out of the startup graph until a startup surface actually needs it. Defer behind the route or interaction that uses it: automation readiness loads on the first read of its hook, and System busyness renders only when opened.
- The Solid runtime belongs in startup only once a startup surface renders with Solid, which happens when the Solid shell lands. Pulling it in earlier is a regression.
- Icons and shared primitives are on the startup path. A primitive port must not grow startup bytes, so measure it.
- Measure with `pnpm ui:build` plus the strict performance check, and compare against the merge base on the **same machine**. The same commit can differ by several hundred bytes between environments.
- The Solid shell (root, shell, outlet) measured about 18 KB gzip smaller than the Lit shell it replaces.

## Rendering

- Fine-grained updates replace `requestUpdate`. A component re-runs nothing; only the computations that read a changed signal do. Don't recreate that broadness with large memos over whole snapshots: derive narrowly.
- Lists: `<For each keyed>` by semantic key. Never key by index or streaming text.
- Large transcripts stay on the existing virtualizer owners; no `@tanstack/solid-virtual`.
- Streaming markdown goes through the framework-neutral `MarkdownDomReconciler`, driven from a ref factory; Solid never renders inside the markdown island.
- xterm, noVNC, and iframes own their DOM: Solid hosts the island and never renders inside it.

## Plugin bundles

Plugin views ship their own Solid runtime (the X plugin bundle went from 36 KB to 83 KB; Workboard grew by 62 KB). That's accepted: plugins can't share the host's private modules. Keep each plugin within its asset limits.
