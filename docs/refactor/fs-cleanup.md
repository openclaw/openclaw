---
title: "fs-safe Cleanup Plan"
summary: "Plan for consolidating OpenClaw filesystem helpers around @openclaw/fs-safe"
read_when:
  - You are refactoring OpenClaw filesystem helpers
  - You are changing @openclaw/fs-safe imports, wrappers, or plugin SDK file APIs
  - You are deciding whether a local file helper belongs in OpenClaw or fs-safe
---

## Status

Implemented on `codex/extract-fs-safe-primitives`. Keep this file as the
cleanup checklist for follow-up reviews and future fs-safe surface changes.

## Goal

Make OpenClaw's filesystem access boring and predictable:

- Core code uses one small set of OpenClaw wrappers that apply OpenClaw policy.
- Plugin SDK compatibility aliases stay deliberate and documented.
- fs-safe keeps a small public story centered on `root()`, with lower-level
  primitives behind explicit subpaths.
- Duplicate JSON, temp, private-store, and path helper names disappear from
  OpenClaw internals.
- Security-sensitive behavior keeps regression tests before names move.

## Non-goals

- Do not remove public plugin SDK exports in this cleanup. Keep deprecated
  aliases until a versioned SDK migration removes them.
- Do not make fs-safe a sandbox. It remains a library guardrail for local file
  access, not OS isolation.
- Do not convert all absolute-path reads to root-bounded reads. Some OpenClaw
  paths are trusted absolute paths and should stay explicit.
- Do not chase cosmetic import churn without reducing helper count or clarifying
  trust boundaries.

## fs-safe Package Pin

`@openclaw/fs-safe` is published on npm and consumed through a semver range.
Fresh checkouts and CI runners should install the package from the public
registry, not from a local `link:../fs-safe` checkout or a GitHub tarball.

Current range:

- `^0.1.0`

The published package ships built `dist` files, so OpenClaw should not list it
in `pnpm.onlyBuiltDependencies`.

## Current Shape

fs-safe's main entry is intentionally narrow:

- `root`
- `FsSafeError`
- `categorizeFsSafeError`
- root option/result types
- Python helper configuration

The wider surface lives behind subpaths:

- `/json`
- `/store`
- `/temp`
- `/atomic`
- `/root`
- `/advanced`
- `/archive`
- `/walk`

OpenClaw now keeps fs-safe behind a small wrapper boundary:

- local `src/infra/*` wrappers for core policy defaults
- public plugin SDK aliases, including older names from before fs-safe
- package-local utility exports where importing `src/infra` would cross a
  package boundary

An import-boundary test rejects new direct fs-safe imports outside those
allowed areas.

## Usage Map

### Root-bounded access

Representative use:

- `src/gateway/server-methods/agents.ts`
- `src/agents/pi-tools.read.ts`
- `src/agents/apply-patch.ts`
- `src/plugins/install.ts`
- `src/auto-reply/reply/stage-sandbox-media.ts`
- `src/gateway/canvas-documents.ts`

Keep this family. `root()` is the fs-safe product surface OpenClaw should push
callers toward.

### JSON helpers

OpenClaw still uses many names for the same operations:

- `readJsonFile`
- `readJsonFileStrict`
- `readDurableJsonFile`
- `writeJsonAtomic`
- `loadJsonFile`
- `saveJsonFile`
- `readJsonFileWithFallback`
- `writeJsonFileAtomically`

fs-safe's canonical names are clearer:

- `tryReadJson`
- `readJson`
- `readJsonIfExists`
- `writeJson`
- `readJsonSync`
- `tryReadJsonSync`
- `writeJsonSync`

This was the highest-value cleanup because it removed naming drift without
changing semantics. Compatibility aliases stay in `src/infra/json-files.ts` and
plugin SDK barrels.

### Private state and stores

Representative use:

- `src/commitments/store.ts`
- `src/agents/models-config.ts`
- `src/agents/pi-auth-json.ts`
- `src/cron/run-log.ts`
- `src/secrets/shared.ts`
- `src/infra/device-auth-store.ts`
- `src/infra/device-identity.ts`

Current overlap:

- `fileStore`
- `fileStore({ private: true })`
- plugin SDK private-state aliases

The concepts are now one family. fs-safe exposes private mode through
`fileStore({ private: true })`; OpenClaw internals and bundled plugins use
store-shaped wrappers instead of standalone private JSON/text helpers.

### Temp workspaces

Representative use:

- `src/media/qr-image.ts`
- `extensions/discord/src/send.voice.ts`
- `extensions/discord/src/voice/audio.ts`
- `extensions/qa-lab/src/temp-dir.test-helper.ts`

`tempWorkspace` is the stable useful primitive. One-shot temp targets and
sibling-temp helpers are lower-level implementation tools.

### Atomic writes

Representative use:

- config and session stores
- cron stores
- plugin install paths
- extension state files

Keep atomic replacement as a public fs-safe subpath. OpenClaw should use the
same canonical JSON/text helpers where possible instead of hand-picking lower
level atomic calls for ordinary JSON state.

### Regular, secure, and root file reads

These are not true duplicates:

- `root()` protects root-relative untrusted paths.
- regular-file helpers read trusted absolute paths with regular-file checks.
- secure-file helpers add ownership and mode checks for secret references.

Keep them separate. Document the trust boundary instead of hiding it behind one
generic "read file" helper.

### Archive helpers

Representative use:

- plugin install
- skill install
- marketplace and ClawHub archive flows

Keep as a separate fs-safe subpath. Do not leak archive entry plumbing into
OpenClaw core call sites unless the caller is actually validating archive
metadata.

## Target Design

### OpenClaw imports

Core OpenClaw code should use local policy wrappers:

- `src/infra/fs-safe.ts` for common root/error helpers
- `src/infra/json-files.ts` for the temporary JSON compatibility layer
- `src/infra/private-file-store.ts` until private stores are unified
- `src/infra/replace-file.ts` for low-level atomic replacement
- `src/infra/boundary-file-read.ts` for loader/package boundary reads
- `src/infra/archive.ts` for archive extraction policy
- `src/infra/file-lock-manager.ts` for the rare core service that needs
  manager-style lock lifecycle/diagnostics

New direct imports from `@openclaw/fs-safe/*` should be reserved for:

- package-level utilities outside core that cannot import `src/infra`
- compatibility shims
- code that intentionally consumes a narrow fs-safe subpath, such as
  `openclaw/plugin-sdk/file-lock` using `@openclaw/fs-safe/file-lock`

### Plugin SDK exports

Plugin SDK exports are contractual. Keep aliases even when OpenClaw internals
move to canonical names.

Mark older names as deprecated in types/docs when the replacement is stable:

- `readJsonFileWithFallback` -> `readJsonIfExists` or a store method
- `writeJsonFileAtomically` -> `writeJson`
- `loadJsonFile` -> `tryReadJson`
- `saveJsonFile` -> `writeJson`
- `readFileWithinRoot` -> `root(...).read*`
- `writeFileWithinRoot` -> `root(...).write`

### fs-safe stores

Move toward one store family:

```ts
const store = fileStore({
  rootDir,
  private: true,
  mode: 0o600,
  dirMode: 0o700,
});
```

or a thin alias:

```ts
const store = stateStore({ rootDir, private: true });
```

The store family should cover:

- `read`
- `readText`
- `readJson`
- `readTextIfExists`
- `readJsonIfExists`
- `write`
- `writeJson`
- `remove`
- `exists`
- `open`
- `copyIn`
- `writeStream`
- `pruneExpired`

This cleanup added that store shape in fs-safe, removed the unshipped
`privateStateStore` surface, and moved OpenClaw internals and bundled plugins
onto explicit store reads/writes.

### Temp

Keep stable public temp surface small:

```ts
await using workspace = await tempWorkspace({ prefix: "openclaw-" });
const target = workspace.path("payload.bin");
```

Move one-shot temp target helpers and sibling-temp helpers to advanced/internal
unless a concrete OpenClaw caller needs the public contract.

## Refactor Phases

### Phase 1: Inventory and Guards

- Add a small import-boundary test that lists allowed direct
  `@openclaw/fs-safe/*` imports in OpenClaw core.
- Add regression tests for the JSON symlink behavior kept by
  `src/infra/json-file.ts`.
- Add regression tests for public plugin SDK aliases that must keep resolving.
- Add a doc note to the plugin SDK runtime docs once aliases are marked
  deprecated.

Exit criteria:

- The current compatibility surface is executable-tested.
- New direct fs-safe imports are visible in review.

### Phase 2: JSON Name Cleanup

- Convert OpenClaw internal callers from old JSON names to canonical fs-safe
  names where the semantics are identical.
- Keep plugin SDK aliases unchanged.
- Collapse `src/infra/json-file.ts` and `src/infra/json-files.ts` into one
  compatibility module if that reduces indirection without losing symlink
  semantics.
- Keep `saveJsonFile` symlink-target behavior until every caller/test is
  intentionally migrated.

Exit criteria:

- Core internal code no longer imports `readJsonFileStrict`,
  `readDurableJsonFile`, or `writeJsonAtomic` unless it is a compatibility shim.
- Plugin SDK aliases still pass import/type tests.

### Phase 3: Store Unification

- Add the unified private mode to fs-safe's store API.
- Remove the unshipped `privateStateStore` surface instead of keeping a second
  store family.
- Migrate OpenClaw private-state internals to the unified store shape in small
  groups:
  - auth/profile state
  - device identity and device auth
  - cron/run logs
  - commitments
  - extension state
- Regenerate the plugin SDK API baseline for the intentional pre-release
  private-helper removal.

Exit criteria:

- OpenClaw internals and bundled plugins do not call standalone private
  JSON/text helpers.
- `fileStore({ private: true })` is the only private multi-file store API.

### Phase 4: Temp Simplification

- Replace OpenClaw one-shot temp target call sites with `tempWorkspace`.
- Keep `resolvePreferredOpenClawTmpDir` as OpenClaw policy.
- Move one-shot temp and sibling-temp helpers out of the curated OpenClaw
  wrapper surface.

Exit criteria:

- OpenClaw uses `tempWorkspace` for temporary file lifetimes unless a low-level
  atomic helper owns the temp path.

### Phase 5: Shim Reduction

- Group one-line fs-safe shims into a smaller number of named OpenClaw policy
  modules.
- Delete shims that are no longer imported.
- Keep shims that preserve public SDK names or OpenClaw-specific defaults.

Candidate stable shims:

- `src/infra/fs-safe.ts`
- `src/infra/json-files.ts`
- `src/infra/private-file-store.ts`
- `src/infra/replace-file.ts`
- `src/infra/boundary-file-read.ts`
- `src/infra/archive.ts`

Candidate advanced-only grouping:

- path guards
- symlink parent guards
- hardlink guards
- move-path helpers
- file identity helpers
- sibling temp helpers

Exit criteria:

- The local wrapper list has policy meaning, not one file per fs-safe module.

### Phase 6: fs-safe Public Surface Finalization

- Keep `@openclaw/fs-safe` main entry curated.
- Keep `root()` as the primary README/API story.
- Keep `openPinnedFileSync` internal. Use `readSecureFile`, `root().open`, or
  `openRootFile*` wrappers instead of exposing the fd-level pinned primitive.
- Keep `createSidecarLockManager` internal. Public callers should use
  `acquireFileLock` / `withFileLock`; `createFileLockManager` is subpath-only
  for long-lived services that need held-lock inspection or drain/reset.
- Move rare root escape hatches such as `openWritable` to advanced only if API
  checks show no supported caller needs the main root interface.
- Keep `regular-file`, `secure-file`, archive, and root helpers separate
  because their trust models differ.
- Remove or mark unstable any standalone helper that is fully covered by root or
  store methods.

Exit criteria:

- fs-safe has a stable pre-1.0 public surface.
- OpenClaw imports only stable fs-safe APIs outside compatibility shims.

## Verification

Use targeted proof per phase:

- JSON cleanup:
  - JSON symlink tests
  - plugin SDK JSON-store import tests
  - representative extension tests that use JSON store aliases
- Store unification:
  - private mode tests in fs-safe
  - auth profile persistence tests
  - device identity tests
  - cron/run-log tests
- Temp cleanup:
  - media temp tests
  - Discord voice temp tests
  - QA-lab temp helper tests
- Shim reduction:
  - plugin SDK API generation/check
  - import-boundary tests
  - `pnpm build`

Before merging a broad cleanup batch, run the changed gate and build:

```sh
pnpm check:changed
pnpm build
```

Implementation proof from this cleanup:

- `pnpm test src/infra/fs-safe-import-boundary.test.ts src/plugin-sdk/temp-path.test.ts src/agents/models-config.write-serialization.test.ts src/infra/json-file.test.ts src/infra/json-files.test.ts`
- `pnpm test src/infra/fs-safe-import-boundary.test.ts src/infra/device-auth-store.test.ts src/infra/device-identity.test.ts src/infra/exec-approvals.test.ts src/agents/models-config.write-serialization.test.ts src/agents/pi-embedded-runner/openrouter-model-capabilities.test.ts src/agents/harness/native-hook-relay.test.ts`
- `pnpm test src/infra/fs-safe-import-boundary.test.ts src/infra/hardlink-guards.test.ts src/infra/file-identity.test.ts src/plugin-sdk/fs-safe-compat.test.ts src/plugin-sdk/temp-path.test.ts`
- `pnpm plugin-sdk:api:check`
- `pnpm build`
- Blacksmith Testbox `pnpm install --frozen-lockfile --config.minimum-release-age=0 && pnpm check:changed`
- In `../fs-safe`: `pnpm docs:site && pnpm build && pnpm test test/api-coverage.test.ts test/new-primitives.test.ts`

## Review Checklist

- Does this change reduce a public name, local wrapper, or duplicated semantic
  family?
- Is the old name public plugin SDK surface? If yes, keep a deprecated alias.
- Does the replacement preserve symlink, hardlink, mode, and missing-file
  behavior?
- Is the caller using an untrusted relative path, trusted absolute path, secret
  path, archive entry, or temp lifetime? Pick the helper that says that out
  loud.
- Are docs and plugin SDK API snapshots updated when exported names change?
