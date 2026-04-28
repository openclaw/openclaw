## Summary

Add `canon` as a recognized `WikiPageKind` so files in the vault's `canon/` directory are indexed by `wiki.search`, `wiki.get`, `wiki.status`, and the compile pipeline. Until now the bridge only walked `entities/`, `concepts/`, `sources/`, `syntheses/`, and `reports/` — daily canon roll-ups (`canon/<date>.md`) written directly into the vault by reflective dreaming agents were invisible to MCP queries despite being valid wiki pages.

## Why

Reflective-dreaming agents write `canon/<date>.md` daily roll-ups directly to the vault. They aren't `MemoryPluginPublicArtifact`s (which the existing `bridge.ts` dispatcher handles), so they bypassed the import path entirely. The vault-walker side (`QUERY_DIRS`, `COMPILE_PAGE_GROUPS`, `collectVaultCounts`) didn't know about the `canon/` directory either, so:

- `wiki.get canon/2026-04-25.md` returned `null`
- `wiki.search` for canon body text returned 0 hits from the wiki corpus
- `wiki.status.pageCounts` had no `canon` field
- The agent digest didn't persist canon pages

## Changes

- `markdown.ts`: add `"canon"` to `WIKI_PAGE_KINDS` + canon/ branch in `inferWikiPageKind` so `toWikiPageSummary` can classify these pages.
- `query.ts`: add `"canon"` to `QUERY_DIRS` so `listWikiMarkdownFiles` + `resolveQueryableWikiPageByLookup` pick up canon pages.
- `status.ts`: add `canon: 0` to both `pageCounts` initializers (live and vault-missing fallback) + extend `dirs` loop in `collectVaultCounts`.
- `compile.ts`: add canon entry to `COMPILE_PAGE_GROUPS` so `readPageSummaries` walks `canon/` during compile and `writeAgentDigestArtifacts` persists canon pages into the agent digest. Add canon counter to `buildPageCounts`.
- `memory-palace.ts`: add canon to `PALACE_KIND_ORDER` + `PRIMARY_PALACE_KINDS` + `PALACE_KIND_LABELS` so canon shows up alongside syntheses/entities/concepts in the palace view.
- `status.test.ts`: update vault-missing fixture for the new field.

## Test plan

- [x] Local verification on Mac mini: `wiki.status` reports `canon: 4`, `wiki.get canon/2026-04-25.md` returns full content with `kind: "canon"`, `wiki.search` returns canon hits ranked above memory-corpus matches for queries that match canon body text, `openclaw wiki compile` regenerates the digest with canon entries.
- [x] tsgo + oxlint + madge cycle check all pass on commit (pre-commit hooks green).
- [ ] CI pipeline (vitest, type-check, build) — pending merge gate.
- [ ] No regression to existing dirs (entities/concepts/sources/syntheses/reports) — verified locally; counts unchanged for those buckets.

## Related

Patches the same area as the dist-side patches in `~/.openclaw/patches/apply-memory-bridge-fixes.sh` Fix 5 (which retires once this lands).
