# Docs source mapping performance proof

Base: `e08aa74ea39e35d01ba8e8f84e317747aba1bf3f`. The candidate keeps the
existing origin map when replacements leave text unchanged and allocates a new
map only when a replacement changes it. Callback execution is unchanged.
The measured `scripts/lib/docs-markdown.mjs` SHA-256 was
`f3cb5b66d05dafe2a754ada402240bc59865fb66e92b29f858129c3da612e47d`
(base: `719c111b9057b07b1468a598f3ce095292d0390616fd9ac34a99bb49d991f443`).

## Measurements

On Linux aarch64, Node 24.22.1 and pnpm 12.15.0, after a frozen dependency
install, `CI=true corepack pnpm docs:check-links` was run in three interleaved
baseline/candidate pairs (AB, BA, AB), with the same checkout, environment and
warm caches. Seconds:

| Pair |   Base | Candidate |
| ---- | -----: | --------: |
| 1    | 15.583 |    11.677 |
| 2    | 15.369 |    11.420 |
| 3    | 15.590 |    11.483 |

Median wall time fell from 15.583 s to 11.483 s (4.100 s, 26.3%). Every run
exited zero with identical stdout and stderr, checking 16,514 internal links and
finding zero broken links. Median waited-child user time was 16.055 vs 13.496 s;
median system time was 2.978 vs 1.315 s; median maximum waited-child RSS was
1,233,196 vs 937,208 KiB. RSS is a maximum, not the sum of concurrent processes.
These local samples do not establish hosted CI, full workflow, or billing savings.

A diagnostic run observed 18,577 mapped replacements, of which 13,693 returned
the matched text unchanged. The baseline copied 313,141,583 origin entries in
those unchanged replacements. This is a work count, not a claim that the same
amount of time is saved.

## Behavior and checks

For each of 1,429 nonlocalized Markdown/MDX files, the accompanying snapshot
script hashes parsed tokens, rendered HTML, IDs, links with source lines, and
collisions. Baseline and candidate per-file snapshots were byte-identical; the
aggregate digest was
`27778f56973fc6e4fb0f35b5842b22e99cfd93c57175435c5cb9d174d1009cbf`.
To reproduce the comparison, run
`pnpm docs:check-links:snapshot /tmp/docs-corpus.json` from the candidate root.
Copy `scripts/ci-docs-corpus-snapshot.mjs` to the same relative path in a
baseline checkout, then run it there with
`node scripts/ci-docs-corpus-snapshot.mjs /tmp/docs-corpus.json`. Compare the
resulting JSON files. This checks the current corpus, not every possible input.

`corepack pnpm test test/scripts/docs-component-attributes.test.ts test/scripts/docs-component-literals.test.ts test/scripts/docs-markdown.test.ts --maxWorkers=1`
passed 30 tests after formatting. New controls check source lines across CRLF,
component rewrites, Unicode and snippet expansion. Oxfmt, focused Oxlint and the
staged test-lines ratchet passed. The local test runner fell back to Node because
it could not stage the pinned Bun fork; a CI-mode lint attempt encountered the
same staging failure. Hosted CI is needed for that runtime's results.
