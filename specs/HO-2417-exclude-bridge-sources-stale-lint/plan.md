# Implementation Plan: HO-2417

## Summary

Exclude only source-sync-managed `bridge` paths from the `stale-page` branch
while preserving all ordinary page and claim freshness checks.

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

## Implementation Approach

Use the persisted source-sync state already loaded by the lint entry point to
derive a normalized bridge-only path set. Thread that set into the existing
page-issue collector and add one predicate to the stale-page emission branch.
Do not write markdown, mutate timestamps, or alter compile/report generation.

## Validation

- Extend the tracked-import lint fixture with stale bridge, unsafe-local, and
  ordinary entity assertions.
- Run focused `extensions/memory-wiki` tests.
- Run production and test extension typechecks.

## Missing Part

None. This is an internal plugin lint-policy change with local deterministic
test coverage; no deployment, external contract, or UI validation is needed.
