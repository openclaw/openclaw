Summary

Found a real PR-caused compile regression, repaired it locally, and added regression coverage. The memory-wiki scoped tests and `pnpm check` now pass. `pnpm build` still fails for an unrelated branch-age issue outside this PR surface.

Repair patch: /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-10-20260428T145529Z/anvil-repair.patch

Vision

Make `canon/*.md` daily roll-up pages first-class memory-wiki pages: classify them as `kind: "canon"` and include them in search/get, status counts, compile indexes, agent digest output, and memory palace grouping.

Acceptance Criteria

- `canon/*.md` is a valid `WikiPageKind`.
- `wiki.search` and `wiki.get` can read canon pages from the vault.
- `wiki.status.pageCounts.canon` is present and text status reports it.
- `openclaw wiki compile` does not fail on initialized vaults and writes root, directory, and digest entries for canon pages.
- Repair/lint/compile paths keep canon frontmatter structure consistent.
- No new auth, billing, Firestore, or checkout surface is introduced.
- Regression tests cover canon behavior across classification, query, status, compile, palace, vault init, and repair.

Verdict

REPAIR

Findings

High, fixed: the PR added `canon` to compile groups, but vault initialization did not create `canon/`. `compileMemoryWikiVault` writes each directory index via `fs.writeFile` in `extensions/memory-wiki/src/compile.ts:587`, so ordinary initialized vaults failed on `canon/index.md`. Reproduced with the existing compile test before repair; fixed by adding `canon` to `extensions/memory-wiki/src/vault.ts:10`.

Medium, fixed: visible status/root-index surfaces were still incomplete. `pageCounts.canon` existed, but status text and the root index count summary omitted it. Fixed in `extensions/memory-wiki/src/status.ts:312` and `extensions/memory-wiki/src/compile.ts:705`.

Medium, fixed: repair scanning did not include canon pages, so `wiki repair` could leave canon pages structurally inconsistent. Fixed in `extensions/memory-wiki/src/structure-repair.ts:47`.

Repairs Attempted

Added `canon` to vault initialization and repair page dirs, included canon in status/root index rendering, and added focused tests in memory-wiki for classification, compile/digest, query/get, status, palace, repair, and vault layout.

Verification

- `pnpm install`: passed.
- Pre-repair reproduction: targeted compile test failed with `ENOENT ... canon/index.md`.
- `pnpm test extensions/memory-wiki/src/compile.test.ts -t "writes root and directory indexes for native markdown"`: passed after repair.
- `pnpm test extensions/memory-wiki/src`: 22 files, 109 tests passed.
- `pnpm check`: passed.
- `git diff --check`: passed.
- `pnpm build`: failed outside this PR surface because `extensions/bench-reflective-dreaming/index.ts` is missing on this PR head; current `origin/main` has it from `88e122dc27`.

Remaining Risks

Full build was not verified on this detached PR head because of the unrelated missing bench-reflective-dreaming bundler stub. The repair itself is covered by memory-wiki tests and repo check.

Recommended Repair Pass

Apply the repair patch, update/rebase the PR branch onto current `main` so `extensions/bench-reflective-dreaming/index.ts` is present, then rerun:

`pnpm test extensions/memory-wiki/src`
`pnpm check`
`pnpm build`

Handoff

Do not merge the original PR as-is. Merge can proceed after applying the repair patch and clearing the build gate on an up-to-date branch.
