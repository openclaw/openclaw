# Upstream Delta bb6f37: Plugin Metadata Lifecycle Cache Cleanup

## Decision

Port the lifecycle-cache invalidation shape from upstream `e7c696a5b0`
without porting the broader plugin metadata snapshot process-memo series.
Rockie currently has only the Gateway-owned current metadata snapshot, but
using the upstream-style fanout helper keeps the existing lifecycle behavior
and gives a future memo layer one invalidation hook.

## Scope

Implement:

- `src/plugins/plugin-metadata-lifecycle.ts`
  - `clearPluginMetadataLifecycleCaches()` clears current snapshot state and
    then calls an optional registered process-memo clearer.
  - `registerPluginMetadataProcessMemoLifecycleClear()` returns an
    identity-guarded disposer so tests and future replacements do not leak.
- `src/gateway/server.impl.ts`
  - `runClosePrelude()` calls `clearPluginMetadataLifecycleCaches()` after
    `markClosePreludeStarted()` and before loading close-prelude work.
- `src/plugins/installed-plugin-index-store.ts`
  - Both async and sync persisted-index writes call the lifecycle helper after
    successful persistence.

Cover:

- Helper fanout, disposal, and replacement/disposer identity behavior in
  `src/plugins/plugin-metadata-lifecycle.test.ts`.
- Async and sync installed-index write callsites in
  `src/plugins/installed-plugin-index-store.test.ts`.
- Real Gateway `close()` path ordering in
  `src/gateway/server-import-boundary.test.ts`.

## Non-Goals

- Do not port upstream's metadata snapshot process memo, clone helpers,
  persisted-registry fingerprinting, or `resolvePluginMetadataSnapshot`.
- Do not update `scripts/test-projects.test-support.mjs`.
- Do not change plugin discovery, manifest registry loading, installed-index
  schema, Gateway startup plugin selection, Rockie broker runtime, or
  `OPEN_NOTEBOOK_*` compatibility.

## Validation

- `pnpm test src/plugins/plugin-metadata-lifecycle.test.ts src/plugins/current-plugin-metadata-snapshot.test.ts src/plugins/installed-plugin-index-store.test.ts`
- `pnpm test src/gateway/server-import-boundary.test.ts`
- `pnpm exec oxfmt --check --threads=1` on changed TS/test files.
- `git diff --check`
