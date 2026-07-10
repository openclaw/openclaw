---
name: openclaw-changelog-update
description: Regenerate OpenClaw release changelog sections from git history before beta or stable releases.
---

# OpenClaw Changelog Update

Use this for release changelog rewrites and GitHub release-note source text.
This is mandatory before every beta, beta rerun, stable release, or stable
rerun. Use it with `release-openclaw-maintainer`; this skill owns changelog
content, ordering, grouping, and attribution discipline.

## Goal

Rebuild the target `CHANGELOG.md` version section from a complete, generated
history manifest, not stale draft notes. Produce grouped user-facing release
notes sorted by user interest while preserving every relevant issue/PR ref and
every human `Thanks @...` attribution.

## Inputs

- Target base version: `YYYY.M.PATCH`, without beta suffix.
- Base tag: the previous shipped release used to locate the unique raw-object
  merge base. It may be on a divergent release line. Repeat it as
  `--shipped-ref` when it is also publication evidence.
- Target ref: exact branch/SHA being released.
- Source target: optional immutable contribution cutoff. When `--target` is a
  later final candidate, every commit after `--source-target` must form a
  linear, association-free, reference-free `CHANGELOG.md`-only tail bounded by
  `--max-changelog-tail`.

## Workflow

1. Start on `main` before branching when possible:
   - `git fetch --tags origin`
   - `git pull --ff-only`
   - confirm clean `git status -sb`
2. Audit integration order, then let the verifier enumerate the complete raw
   commit DAG including direct and off-first-parent commits:
   - `git log --first-parent --date=iso-strict --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - `git log --first-parent --grep='(#' --date=short --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - also inspect `--since='24 hours ago'` when main moved during the release.
3. Generate the complete contribution record and editorial manifest before
   writing grouped prose:

   ```bash
   node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
     --base <base-tag> \
     --target <target-ref> \
     --source-target <product-cutoff-sha> \
     --max-changelog-tail <count> \
     --comparison-base main \
     --tooling-commit <trusted-main-sha> \
     --tooling-tree <trusted-main-tree> \
     --version <YYYY.M.PATCH> \
     --manifest /tmp/openclaw-release-<YYYY.M.PATCH>.json \
     --write-ledger
   ```

   - the manifest is the required input to the rewrite, not an after-the-fact
     audit; it contains every referenced PR, eligible contributor credit,
     inline issue context, every direct commit, and an editorial-eligibility
     classification for PRs and direct commits
   - release acceptance uses manifest schema v6. Supply `--tooling-commit` and
     `--tooling-tree` together from trusted `main`; the verifier hashes every
     executed local module, verifies all four bytes against that commit, and
     records per-file plus aggregate SHA-256 evidence. When the verifier is
     copied into a release worktree, copy its two inventory modules and
     `scripts/render-github-release-notes.mjs` from the same trusted commit too;
     a mixed trusted/target module set fails closed
   - for a historical backfill, add `--seed-ref <pre-backfill-ref>` once so
     contribution records from the prior changelog are retained even when an
     older merged commit omitted its PR number; the verifier excludes records
     for work reverted after the base tag, including beta work reverted before
     the stable release
   - add repeatable `--shipped-ref <prior-shipped-tag>` when the reachable main
     closeout differs from the shipped tag or later forward-port commits
     re-associate PRs that were already released. Each tag is a cumulative
     shipped boundary: exact tag content and patch equivalence decide whether
     work shipped, while complete numbered contribution records provide
     auditable attribution metadata and `Unreleased` is ignored. An incomplete
     historical credit row cannot veto exact content proof. Never infer this
     boundary from the base SHA, target prose, or target record. The manifest
     and generated provenance retain each tag plus the exact excluded PR
     inventory and count for deterministic candidate validation
   - source PR ownership comes from complete GitHub commit associations, a
     strict terminal/directive PR reference, or exact cherry-pick/patch
     provenance under a repeatable trusted `--provenance-ref`
   - when a PR branch was rebased before merge and GitHub no longer associates
     its original commit, add `--provenance-pr <PR>:<full-SHA>` only with
     operator-supplied provenance. The verifier requires a PR merged by the
     source cutoff, one unique exact PR-member patch, and one unique
     trailer-linked target patch. It records the PR member, trailer origin,
     target commit, patch IDs, paths, and diff hashes separately
   - for a deliberately partial backport, use
     `--provenance-pr-partial <PR>:<source-SHA>:<target-SHA>`. The source SHA
     must be an actual associated PR member, the target must carry the exact
     `Partial backport of <source-SHA>` trailer plus PR reference, and the
     target paths must be a strict non-empty subset whose per-path stable patch
     IDs all match and whose patches reproduce the exact opposite path state
     when applied bidirectionally. Partial evidence never weakens exact
     provenance
   - for a conflict-resolved backport that intentionally changes the same file
     set, use `--provenance-pr-adapted <PR>:<origin-SHA>:<target-SHA>`. The
     origin normally matches exactly one actual PR member. A GitHub squash
     origin is accepted only when it is the immutable associated merge commit,
     its one-parent patch exactly equals the complete PR-member aggregate from
     the unique base/head merge base, and every aggregate path has recorded
     squash/target hashes. The active target must carry the exact cherry-pick
     trailer, change the same non-empty path set, preserve at least one path
     bidirectionally, and adapt at least one path. This is operator-reviewed
     provenance, not a generic non-equivalent cherry-pick fallback
   - for an adapted PR-head backport that also integrates selected exact path
     patches from earlier commits in the same PR, repeat
     `--provenance-pr-integrated <PR>:<source-SHA>:<target-SHA>` once for every
     reviewed source commit. The target's sole cherry-pick trailer identifies
     the primary source, which must be the immutable PR head; every other
     supplied source must be an earlier exact PR member. The primary path set
     must be a strict subset of the target path set, preserve at least one exact
     path, and adapt at least one path. The target parent must be the exact
     trailer-linked backport of the PR head's parent. Every added target path
     must match exactly one explicit earlier member by stable per-path patch ID
     and bidirectional path-state application, and that member's resulting path
     state must survive unchanged into the PR head's parent. The manifest
     records exact, adapted, integrated, and omitted source paths with their
     hashes. This mode never infers an integration source from patch similarity
     alone
   - `--comparison-base main` runs the canonical merged-main search over the
     exact raw merge-base timestamp through the immutable source-target
     timestamp. A later CHANGELOG-only final target never widens the
     contribution universe. GitHub
     Search windows are split and paginated with exact record/member hashes;
     each record binds the immutable base, head, and merge commit.
     The team universe must reconcile disjointly as canonical source PRs,
     post-fork/unbackported PRs, shipped-or-boundary PRs, or net-reverted PRs;
     `unclassified` must be empty
   - every post-fork classification proves the PR head, member commits, and
     merge commit are outside target ancestry and have no target association,
     ownership/strict explicit reference, cherry/adaptation origin, or exact
     patch equivalent. Exact patch proof covers the merge first-parent patch,
     the aggregate patch from the unique base/head merge base through the
     immutable PR head, and every member patch unless its exact zero-context
     post-state is already present at both that immutable base and head. Only
     post/post state whose reverse reconstructs the same zero-context patch at
     both snapshots is branch-local cleanup. Ambiguous, dependent, relocated,
     and rename states stay fail-closed unless every candidate path belongs to
     the PR aggregate, the target exactly matches the immutable aggregate base
     state on every aggregate-changed path, and no source-only commit outside
     aggregate-base ancestry touches any aggregate-changed path. This lets a
     shifted duplicate hunk be classified absent while keeping reverted
     backports fail-closed.
     Final-tree aggregate proof must reverse and reapply to the exact target
     tree and records the patch id, diff hash, changed paths, target tree, proof
     strength, and proof method.
     A zero-context round-trip may conservatively block a post-fork absence
     classification when three-way application conflicts, but it never proves
     shipped exclusion. Generic contextual mentions are recorded but are not
     backport evidence. Any ownership evidence fails closed as missing
     canonical work. Because GitHub's merge window is inclusive to the second,
     a lower-bound PR is a boundary item only when its immutable merge commit
     is already ancestral to the raw merge base
   - every strict ownership reference must resolve to a pull request merged by
     the source-target cutoff; trailing issue references remain metadata, while
     issue-valued directives, open PRs, and later merges fail closed instead of
     becoming contribution rows
   - generic `#NNN`, `Fixes #NNN`, title, note, and legacy references are
     metadata only; they never create PR ownership
   - resolve every association page and fail closed on GraphQL errors, missing
     aliases/connections, count drift, duplicate members, or repeated cursors.
     API transport, rate-limit, 5xx, and upstream HTML failures use one bounded
     retry budget; auth, validation, and other permanent failures stop
     immediately, and nonzero API commands never count as JSON success
   - when a post-fork PR member shares a stable patch with an independently
     authored main commit and a release direct commit, use
     `--comparison-pr-member-overlap <PR>:<member-SHA>:<target-SHA>:<main-witness-SHA>`
     only to acknowledge the two expected comparison scanner records. This is
     explicit non-ownership evidence: the target stays direct, the PR stays
     post-fork, and no contribution row is added. The verifier requires the
     member to survive the immutable PR head, actual merge parent, and merge
     result by exact-path zero-context round-trip while its changed lines are
     absent from the merge first-parent diff. Each member hunk must have one
     contextual occurrence in the aggregate base, member parent/result, and
     target parent/result; the target parent must match the aggregate-base path
     state, and pre-member setup changes must occur after the member hunk. The
     target and main witness must have identical raw diffs, paths, author
     identity/time, and message; that witness must be the only independent exact
     path match across the merge parent's full ancestry, must lie on the merge
     parent's first-parent path, and its target path state must survive every
     later first-parent path-touching commit through the actual merge parent.
     The PR member has the sole stated PR association, while the target and
     witness are association/reference/trailer-free. The member predates the
     target, the witness predates the target, and all three commits are
     ancestry-separated and disjoint from every ownership provenance mode. Any
     extra member, scanner match, aggregate presence, shifted hunk, missing
     witness, or unused directive fails closed.
   - resolve commit-author pages completely so verified non-noreply co-authors
     retain contributor credit
   - the manifest records canonical/current/generated/missing/stale PR members
     and sorted-newline hashes, per-row missing/stale reason evidence, both the
     manifest-direct and exclusive-direct commit sets plus overlap equation,
     every commit disposition, ownership evidence, and the raw merge base.
     Schema v6 preserves both pre-write and post-write reconciliations, the
     normalized semantically material invocation, resolved seed authorization
     (or `null`), executed tooling identity, and the exact candidate changelog
     and release section SHA-256. Its inventory v4 also binds the exact queried
     commit-association partition, every explicit issue/PR reference, immutable
     trusted-provenance PR metadata and members, complete comparison records,
     and each shipped baseline's history, verified revert edges, and recursively
     active commits. The top-level reference-entry digest independently binds
     every issue/PR node used to generate the contribution ledger.
     Ledger writes require generated rows to match canonical ownership except
     for an explicit `--seed-ref` historical backfill. `--manifest` must never
     alias `CHANGELOG.md`, including case-folded and symlink aliases. A ledger
     write commits a pending manifest first, the changelog second, and a pass
     manifest last with sibling temp-file renames; detected concurrent mutation
     aborts without overwriting the other writer's bytes. Accept a pass only
     when the current invocation exits zero, its normalized invocation matches,
     and recomputed `CHANGELOG.md` and release-section SHA-256 values match the
     manifest artifacts; `status: "pass"` alone is never sufficient
   - read the manifest before editing `### Highlights`, `### Changes`, or
     `### Fixes`; do not carry old grouped prose forward without re-auditing it
   - inspect linked PRs/issues or diffs for ambiguous commits. Direct commits
     are editorial input, not public ledger rows; infer material user outcomes
     from subject, body, touched files, tests, and nearby commits

4. Rewrite one stable-base section only:
   - use `## YYYY.M.PATCH`
   - do not create beta-specific headings
   - do not leave a stale `## Unreleased` section above the target release
   - if `Unreleased` contains release-bound notes, fold them into the target
     section instead of deleting them
5. Section shape:
   - `### Highlights`: 5-8 bullets, broad user wins first
     - include only a clear user-visible capability or workflow unlock, a
       material reliability/safety fix, a broad cross-surface improvement, or
       a release-defining integration/compatibility milestone
     - every highlight must say what changed for a user in one sentence; use
       one user story per bullet and group its supporting PRs
     - exclude tests, CI, refactors, docs, catalog churn, and implementation
       detail unless the outcome is a material install/update, data-safety, or
       widely visible user improvement
   - `### Changes`: new capabilities and behavior changes
   - `### Fixes`: user-facing fixes first, grouped by impact and surface
   - group related changes/fixes by surface and user impact; avoid one bullet
     per tiny commit when several commits tell one user-facing story
   - `### Complete contribution record`: generated PR-first record after the
     grouped prose; it is the exhaustive accounting surface, not a second
     release summary
6. Preserve attribution:
   - keep `#issue`, `(#PR)`, `Fixes #...`, and `Thanks @...`
   - every human-authored merged PR represented by a user-facing entry needs
     its PR ref and `Thanks @author`, even when the PR had no linked issue
   - every human issue reporter for a `Fixes #...` or referenced bug issue
     represented by a user-facing entry needs `Thanks @reporter` unless the
     same handle is already thanked in that bullet
   - every human `Co-authored-by` contributor on represented user-facing work
     needs `Thanks @handle` when a GitHub handle is known
   - when grouping multiple PRs/issues in one bullet, include every relevant
     PR/issue ref and every human contributor handle in that same bullet
   - multiple `Thanks @...` handles in one bullet are expected; do not drop or
     collapse contributor credit just because the note is grouped
   - if one grouped bullet covers both direct commits and PRs, keep all PR refs
     and thanks, plus any issue refs and human credit from the direct work
   - issues remain normal inline `#NNN` references. Do not add a separate
     linked-issues inventory. The generated PR record keeps source issues
     inline as `Related #NNN` on the PR that shipped them
   - when backfilling an older linked-issues inventory, preserve reporter
     credit inline for every GitHub-confirmed closing PR relationship. Do not
     infer a PR relationship from a generic cross-reference event, invent an
     unrelated PR link for a standalone report, or recreate the retired
     inventory
   - the complete contribution record lists every merged source PR exactly once
     as `**PR #NNN**`; source PRs include GitHub commit associations and merged
     PR references explicitly present in active commit subjects/bodies. It
     preserves author/co-author credit and any issue references in the original
     title
   - direct commits remain in the manifest with GitHub-resolved author,
     co-author, issue, and editorial-eligibility data. They inform grouped
     prose but are never rendered as a public `#### Direct commits` dump. Add
     direct-commit credit to a grouped bullet only when it shares an explicit
     closing issue reference or at least two distinctive subject terms
   - the verifier rejects `docs`, `test`, `refactor`, `ci`, `build`, `chore`,
     and `style` PRs in Highlights, Changes, or Fixes. Keep those internal
     contributions in the complete PR record, but do not give them editorial
     release-note space
   - classify internal-only work from conventional prefixes and clear title
     signals such as `QA`, `test`, `docs`, `refactor`, `lint`, or `CI`; an
     untyped title is not automatically editorial
   - do not add GHSA references, advisory IDs, or security advisory slugs to
     changelog entries or GitHub release-note text unless explicitly requested
   - never thank bots, `@claude`, `@openclaw`, `@clawsweeper`, or `@steipete`
   - do not use GitHub's release contributor count as the source of truth; the
     changelog must carry the complete human credit set itself
7. Sorting preference:
   - security/data-loss and content-boundary fixes
   - transcript/replay/reply delivery correctness
   - channels and mobile integrations
   - providers/Codex/local model reliability
   - install/update/release path reliability
   - performance and observability
   - docs and contributor-only/internal details last or omitted
8. Keep bullets single-line unless existing file style forces otherwise. Avoid
   internal release-process noise unless it changes user install/update safety.
9. Check release-note side conditions:
   - inspect `src/plugins/compat/registry.ts`
   - inspect `src/commands/doctor/shared/deprecation-compat.ts`
   - if any compatibility `removeAfter` is on/before release date, resolve it
     or explicitly record the blocker before shipping
10. Validate and ship:

- after the manifest-driven rewrite, regenerate and verify the complete
  contribution record before committing:
  ```bash
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
    --base <base-tag> \
    --target <target-ref> \
    --tooling-commit <trusted-main-sha> \
    --tooling-tree <trusted-main-tree> \
    --version <YYYY.M.PATCH> \
    --manifest /tmp/openclaw-release-<YYYY.M.PATCH>.json \
    --write-ledger
  ```
- the command fails when any `#NNN` reference in release history or the
  rendered release section cannot resolve, when reverted work is presented
  as shipped, when a source PR is absent from the contribution record, when
  contribution rows are duplicated or disagree with their declared exact
  count, when direct commits are rendered as a public record dump, when
  non-editorial PRs appear in grouped prose, or when an eligible PR author or
  known co-author is missing from that PR's exact `Thanks @...` credit. It also fails
  before history collection when the raw object graph is shallow, grafted,
  replaced, missing, or has an ambiguous merge base, when `### Highlights` has
  fewer than five or more than eight top-level
  bullets, or when the existing prose/record names a PR outside the source
  range. Only an explicit `--seed-ref` may add historical PR inventory; an
  explicit repeatable `--shipped-ref` may subtract PRs proven present in a
  prior shipped tag
- for the audited beta3 historical fixture, the canonical invocation is:
  ```bash
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
    --base v2026.6.11 \
    --target 811ddd96180583bae00001f71971419182ae0520 \
    --source-target 306b800ace5398dcfc5eae6e15dcae533db42c95 \
    --max-changelog-tail 2 \
    --comparison-base main \
    --tooling-commit <trusted-main-sha> \
    --tooling-tree <trusted-main-tree> \
    --shipped-ref v2026.6.11 \
    --provenance-pr 103073:417b9163cacd48aeec5a1ab2d2554cdbc14f9796 \
    --comparison-pr-member-overlap 99242:67f76f2c14bfe010bb244a808e6137c4c44b02b2:00259d07efe08a218e6d561153e730fe2c746e1c:d3ff48c51f4ff4cf3594c04e127c8e3ae83ba021 \
    --version 2026.7.1 \
    --manifest /tmp/openclaw-release-2026.7.1.json \
    --write-ledger
  ```
  Expected arithmetic is `2389 - 421 - 6 - 2 = 1960`, with zero
  unclassified PRs. This fixture proves the algorithm; final release use must
  substitute the exact frozen product cutoff and its sole bounded
  `CHANGELOG.md`-only child/tail. Add trusted provenance refs and partial
  or adapted backports only when their exact commits exist in that candidate's
  source range; never copy later provenance into a historical fixture
- when grouped prose names a PR, that same bullet must retain every
  contributor and linked-reporter credit from its generated PR record
- unqualified `#NNN` references resolve against `openclaw/openclaw`;
  cross-repository references such as `openclaw/imsg#141` remain literal
  text and must not be rewritten as local issue links
- after the GitHub release or prerelease is published, verify every matching
  release page against the same source section:
  ```bash
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
    --base <base-tag> \
    --target <target-ref> \
    --version <YYYY.M.PATCH> \
    --release-tag v<YYYY.M.PATCH> \
    --check-github
  ```
- add one `--release-tag` for every beta and stable page in the train; a
  `### Release verification` tail is permitted, but any other body drift
  fails the check
- `scripts/render-github-release-notes.mjs` is the canonical release-body
  renderer used by candidate validation, publish, and verification. When the
  complete `## YYYY.M.PATCH` section fits GitHub's 125,000-character limit and
  the renderer's matching 125,000-byte safety ceiling, the body must contain
  that exact section including its heading
- when the complete source section exceeds either limit, the renderer keeps the exact
  grouped editorial notes through the line before
  `### Complete contribution record`, then emits that heading with a stable
  link to the full contribution record in the tag-pinned `CHANGELOG.md`.
  Never truncate a bullet or partial record, and never hand-author a different
  compact form
- append `### Release verification` only when it fits after the canonical full
  or compact body is chosen. If it does not fit, omit the body tail and retain
  the immutable attached release evidence; never compact a fitting full
  contribution record just to preserve the optional tail
- `pnpm release:candidate` performs this deterministic render check from the
  exact tag before it dispatches Full Release Validation, including when local
  generated checks are explicitly skipped
- `git diff --check`
- for docs/changelog-only changes, no broad tests are required
- commit with `scripts/committer "docs(changelog): refresh YYYY.M.PATCH notes" CHANGELOG.md`
- push, pull/rebase if needed, then branch/rebase release from latest `main`

## Quota / API Outage Rule

If GitHub API quota is exhausted, do not idle. Continue work that does not need
GitHub API:

- local changelog rewrite and release-note extraction
- local pretag checks and package/build sanity
- git push/tag checks over git protocol
- npm registry `npm view` checks
- exact workflow-dispatch command preparation

Only GitHub Release creation, workflow dispatch, run polling, artifact download,
and issue/PR mutation need API quota.
