# Performance

## Startup bundle

`scripts/check-control-ui-performance.mts` and `config/control-ui-startup-budget-baseline.json` own startup measurement and enforcement: the committed gzip baseline plus growth and build-variance allowances, and one startup CSS request. The baseline itself may not exceed the script's `startupJsGzipBytes` cap. Preserve the lazy graph and compare every changed boot surface against its merge base. A surface already above its cap may not grow beyond the 64-byte build-variance allowance. Lower the startup baseline with the official `--update-baseline --reason` command after a verified reduction, using the measured head value rather than a lower target; raising budgets needs owner approval.

- Keep code out of the startup graph until a startup surface actually needs it. Defer behind the route or interaction that uses it: automation readiness loads on the first read of its hook, and System busyness renders only when opened.
- The Solid shell now owns startup rendering. Its imports must not eagerly register lazy page custom elements or load route-only libraries, even if every importer uses Solid. An eager Zod import previously added about 36 KB gzip.
- Icons and shared primitives are on the startup path. A primitive change must not grow startup bytes, so measure it.
- Measure with `pnpm ui:build` plus the strict performance check, and compare against the merge base on the **same machine**. The same commit can differ by several hundred bytes between environments.

## Rendering

- Fine-grained updates keep invalidation local. A component re-runs nothing; only the computations that read a changed signal do. Don't recreate that broadness with large memos over whole snapshots: derive narrowly.
- Lists: select identity, semantic keys, or anonymous positions deliberately; see [keying](idioms.md#key-lists-by-the-lifetime-you-intend). Never key entities by index or streaming text.
- Large transcripts stay on the existing virtualizer owners; no `@tanstack/solid-virtual`.
- Streaming markdown goes through the framework-neutral `MarkdownDomReconciler`, driven from a ref factory; Solid never renders inside the markdown island.
- xterm, noVNC, and iframes own their DOM: Solid hosts the island and never renders inside it.

## Plugin bundles

Plugin views ship their own Solid runtime (the X plugin bundle went from 36 KB to 83 KB; Workboard grew by 62 KB). That's accepted: plugins can't share the host's private modules. Keep each plugin within its asset limits.
