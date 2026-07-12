# Implementation Plan: HO-2417

## Technical Context

- Package: bundled `extensions/memory-wiki` plugin.
- Lint reads source-sync state and already receives managed imported source
  paths.
- The source-sync entry group distinguishes `bridge` from `unsafe-local`.
- No public SDK, configuration, migration, or UI surface changes.

## Design

Build a second normalized path set from source-sync entries whose group is
`bridge`. Pass that set to the lint issue collector. Exclude only those paths
from the existing stale-page branch. Do not key the exemption on page metadata,
because a manually authored page must not gain the exemption merely by claiming
a bridge source type.

## Validation

- Extend the tracked-import lint fixture with stale bridge, unsafe-local, and
  ordinary entity assertions.
- Run focused `extensions/memory-wiki` tests.
- Run production and test extension typechecks.

## Missing Part

None. This is an internal plugin lint-policy change with local deterministic
test coverage; no deployment, external contract, or UI validation is needed.
