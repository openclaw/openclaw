# fix(memory-wiki): guard against missing agentIds

Fixes `artifact.agentIds is not iterable` that breaks all `wiki_*` tools (`wiki_get`, `wiki_search`, `wiki_lint`, `wiki_apply`, `wiki_status`).

## Root cause

`listMemoryHostPublicArtifacts()` may omit `agentIds` for some workspaces. Newer code started spreading that value directly into `cloneMemoryPublicArtifact()` and into downstream bridge processing, which crashes when `undefined` is encountered.

## Changes

1. Guard `artifact.agentIds` before cloning in `memory-state-CEaNZbtE.js`.
2. Use `artifact.agentIds ?? []` when building `agentIdsByWorkspace` in `cli-DTDS4VQz.js`.
3. Add fallback values to sort comparators so `.toSorted()` never throws on missing fields.

## Reproduction

Call any `wiki_*` tool on a workspace whose metadata does not provide `agentIds`.

## Validation

After applying the patch and restarting the gateway, `wiki_search` returns without throwing.
