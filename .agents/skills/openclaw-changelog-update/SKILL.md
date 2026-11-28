---
name: openclaw-changelog-update
description: Regenerate OpenClaw release changelog sections from git history before beta, stable, or extended-stable releases.
---

# OpenClaw Changelog Update

Use this for changelog rewrites and GitHub release-note source text. For regular
beta/stable, prepare complete notes before final-source qualification when
possible; Code SHA may then also be Release SHA. Editorial work may overlap
Code validation. Do not rerun it per validation-recovery backport; when backports
replace the Code SHA, rerun it once after the final Code SHA is green, as a
genuine CHANGELOG-only descendant under the existing product-evidence reuse
policy ([timing](../release-openclaw-maintainer/references/preparation.md#changelog-and-release-notes)). For
extended-stable, run it before final exact-head validation and tagging. Do not
rerun it for tooling retries, resumed publication, or promotion.
Use it with `release-openclaw-maintainer`; this skill owns changelog content,
ordering, grouping, and attribution discipline.

## Goal

Rebuild the target `CHANGELOG/<version>.md` release section from a complete, generated
history manifest, not stale draft notes. Produce grouped user-facing release
notes sorted by user interest while preserving every relevant issue/PR ref and
every verified human `Thanks @...` attribution.

`CHANGELOG.md` is the generated release index. The shared owner
`scripts/lib/release-changelog.mjs` resolves release sections and contribution
records from a working tree or a pinned Git ref, including historical refs
that still contain a monolith. Use `node scripts/release-changelog.mjs read
--version <version> [--ref <sha-or-tag>]` for a section, or add `--record` for
its contribution record. A missing split artifact must not fall back to the
root index. Historical releases without records gain no invented provenance.
Generated `CHANGELOG/**` files retain exact migrated or mirrored bytes and are
excluded from generic formatting, like the root changelog. Validate them through
their owner with `pnpm changelog:check`.

Current writes use the split layout. To save a complete initial section, use
`node scripts/release-changelog.mjs write --version <version> --file <section.md>`;
it updates the release entry, matching `CHANGELOG/records/<version>.md` when
present, and index together. Initial generation retains the section format in
[generation and verification](references/generation.md). Published docs mirrors follow the separate
[post-release route](#post-release-docs-mirrors); initial generation must never overwrite them.

## Inputs

- Target version: exact `YYYY.M.PATCH-beta.N` for a beta delta; `YYYY.M.PATCH`
  for cumulative stable notes. Beta entries and records are separate frozen
  artifacts, never copies of the stable-base section.
- Beta base tag: capture the version currently selected by public npm
  `openclaw@beta` before publication, not the last GitHub prerelease or the
  highest beta-suffixed version. The selector may name a stable version also
  selected by `latest`. Omit `--base` (or use `--base npm-beta`) with an exact
  beta version to resolve it once; preserve the resolved tag from the generated
  manifest and reuse that explicit `--base` for edits, verification and recovery.
  If npm already selects the candidate or a newer version, generation refuses
  to guess historical selector state; supply the previously captured tag. When
  that tag is not an ancestor (for example a stable closeout forward-port), the
  verifier inventories the full target history absent from that shipped tag and
  subtracts its recorded PRs through `--shipped-ref` semantics. The manifest and
  record retain both boundaries; replay with the captured tag to resolve the
  same range, never select an older GitHub beta instead.
- Stable base tag: the previous **published regular stable release**, even when
  its branch diverges from the target. Omit the base (or use npm-stable) to capture
  public npm's current openclaw@latest before publication. As with beta, a selector
  already at or beyond the candidate requires the previously captured explicit
  tag; local tag ordering is not proof of publication. Extended-stable requires
  an explicit previous published tag on its maintenance line (the selected
  regular-stable cut for that line's first release), never the current regular
  latest. A main-closeout SHA is not a shipped boundary: the
  [v2026.11.4 → v2026.11.5 incident](https://github.com/openclaw/openclaw/pull/200958)
  showed that it can omit unreleased beta development that landed before
  closeout. Explicit ancestral SHAs remain
  readable for historical replay with a diagnostic, not recommended for new notes.
- Divergent histories: keep the selected tag as base in the manifest and public
  contribution provenance; mergeBase is separate traversal information. Inventory
  every commit in base..target, including merged side branches, canonicalize PRs,
  handle reverts, then subtract proven shipped contributions. Never replace the
  selected release with its merge base or the nearest reachable older release.
- Target ref: the exact product-complete history being documented. Its
  contribution-record target must be an ancestor of the final release target;
  it need not name a not-yet-created changelog commit. Include any later fixes
  before finalizing notes. Final notes may be committed before qualification,
  or afterward as a CHANGELOG-only descendant of a green Code SHA.
- Canonical main ref: current `origin/main`, fetched before verification. Release
  notes cite the original merged main PR when the same work is carried by a
  backport. A release-branch PR is used only while no forward-port exists on
  current main. The manifest and generated record freeze the canonical main SHA;
  replay with that exact --main-ref to keep historical alias resolution stable.
  Candidate validation reads that pin, never a moving main branch.

## Workflow

For initial beta, stable, or extended-stable notes, read [generation and verification](references/generation.md) in full before collecting history or rewriting notes. It owns manifest generation, historical accounting, editorial structure, attribution, validation, and release-page parity.

## Post-release docs mirrors

After explicit approval of docs publication, read [post-release docs mirrors](references/docs-mirrors.md) in full. This separate route owns the approved source PR, flattened mirror, docs deployment, and later GitHub Release body update. Do not run an editorial rewrite automatically during release preparation or publication.

## Extended-Stable Variant

Extended-stable has one release commit and one canonical GitHub Release body.
After version prep and approved backports, regenerate `CHANGELOG/YYYY.M.P.md`
with the regular manifest and original-main-PR provenance rules. Commit it directly
to the canonical release branch, then validate the final branch tip before tagging.
Do not open a staging/backport PR for release preparation. The release closeout
renders that tag-owned section into the shared draft before the parent pipeline publishes
the non-Latest release page. Re-audit after a product
backport; a tooling-only repair needs no changelog entry. Never rewrite a
published tag or changelog.

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
