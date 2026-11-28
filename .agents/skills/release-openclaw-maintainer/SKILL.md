---
name: release-openclaw-maintainer
description: "Manage one OpenClaw release or orchestrate release owners across beta, stable, and extended-stable: preparation, fix-inclusion tracing, hotfix routing, publication, handoff, and closeout."
---

# OpenClaw Release Maintainer

Use for a release operation, not ordinary development or advisory mutation.
Read `docs/reference/RELEASING.md` for current policy. Load `$release-private`
when available before resolving private credential locators or host topology;
credential operations use `$one-password`.

## Choose the role

- **Release owner (default):** “Manage this release” owns one release from
  preparation through verification, retrospective, and closeout. Start with
  [the owner lifecycle](references/release-owner.md), even for a short prompt.
- **Release manager / orchestrator:** coordinate several release owners, draft
  their kickoff or handoff briefs, and route hotfix opportunities. Start with
  [manager mode](references/release-manager.md). This role does not become a
  second writer of an owner's release branch or publication state.

The skill owns the general process; the initial prompt carries release-specific
intent, authority, and state, not a copied runbook. A handoff resumes that intent
with current evidence rather than starting another release.

## Choose the operation

Read only the references needed for the selected phase:

- Regular beta/stable preparation or publication: [regular release](references/regular-release.md), which routes preparation and phase-specific proof. If the request does not specify stable/full, default to beta; beta authorization does not authorize later stable promotion.
- Fix status, candidate inclusion, first published version, or cumulative upstream-fix counts: [fix-inclusion tracing](references/fix-inclusion.md).
- Backport discovery and porting: [candidate inventory and worker brief](references/backport-discovery.md). For extended-stable also read [backport preparation](references/extended-stable-backports.md); SDK/config changes need a visible maintenance-risk warning and maintainer decision.
- Extended-stable `.33+` Gateway publication: [extended-stable publication](references/extended-stable-publish.md). Use the shared publisher with extended-stable inputs; its non-Latest GitHub Release carries evidence without native-app or ClawHub publication.
- Validation selection or failed proof: [validation and confidence](references/validation.md), with `$release-openclaw-ci` for workflow execution and immutable manifests.
- Failed validation sealing/collection after checks finish: assess [receipt-backed aggregate recovery](../release-openclaw-ci/SKILL.md#receipt-backed-aggregate-recovery) before replacing the FRV; this is distinct from same-parent continuation and publication recovery.
- Interrupted publication or registry promotion: [publication recovery](references/publication-recovery.md).
- Native assets: [platform publication](references/platform-publication.md), with `$release-openclaw-mac` for macOS operations.
- Stable postpublish synchronization and the exact-SHA deployment handoff:
  [main closeout](references/stable-main-closeout.md).
- Release retrospective and shared issue ledger (every track, and any handoff
  snapshot): [retrospective](references/retrospective.md), including
  [in-flight fix tracking](references/retrospective.md#track-in-flight-fixes-per-agent).
- Release notes: `$openclaw-changelog-update`, including its separate approved post-release docs-mirror route. Initial release generation keeps its existing format; docs publication does not run automatically during release. Requested announcements: `$release-openclaw-announcement` for Discord, `$release-tweets` for X. Announcements never gate publication and require explicit posting authorization.
- Published artifact verification: `$verify-release`. GHSA operations: install and read [`openclaw-ghsa-maintainer`](https://github.com/openclaw/maintainers/blob/main/.agents/skills/openclaw-ghsa-maintainer/SKILL.md) from the maintainer repository; explicit security-workflow authorization is required.

## Backports and new fixes

During preparation, complete the required [bundled Codex update and pin](references/preparation.md#update-and-pin-bundled-codex-required).

For every release track, apply approved changes already on `main` directly to
the canonical release branch, one commit at a time in dependency order with
`git cherry-pick -x`. Keep each backport separate, including the initial set;
never open individual backport PRs or a combined staging/mega PR for that work.
Record source and destination SHAs, adaptations, and proof in the release ledger.

For a new fix not yet on `main`, prefer an individual PR to `main`, then direct
backport after it merges. When urgency requires a release-first fix, commit it
directly to the release branch and track an individual forward-port PR to
`main` after publication, with an owner in the handoff. Do not lose the fix at
closeout. This applies to product, CI, and release-tooling repairs; independently
trusted publishing tooling P must still come from `main`.

CI can be repaired after backports are on the release branch; it is not a
reason to open a backport PR or stage the initial set behind one. Backport an
existing main fix directly; otherwise use the new-fix route above. Run focused
proof and repair branch CI before freezing and qualifying the final candidate.
Required release validation, intake approval, security disclosure, and exact-SHA
evidence remain unchanged; direct backports do not authorize publication.

## Hotfix ledger management

Prefer the [shared hotfix ledger](references/hotfix-ledger-management.md) for
backport discovery, selection, and outcomes, including Tideclaw-owned releases.
Reuse candidates, add discoveries from main/sibling releases, and update each
release's assessments immediately after every backport adaptation, including
new validation failures and their resolution. Parallel release owners may need
the same fix or adaptation before this release finishes. If access is
unavailable, keep each pending update in local evidence and sync later. This is
recommended bookkeeping, not another release gate.

## Fast-track publication uses GitHub approval

Use only the normal GitHub Actions `npm-release` environment approval by an
eligible npm release manager. No separate chat approval, group conversation,
Firebase service, approval URL or manually supplied decision is required.
Agents may prepare the request and artifacts within task authority, but must
never approve the environment using a release manager's token.

Pass `--fast-track-request <packet.json>` to `pnpm release:publish-preflight`;
it forwards `fast_track_request` through the existing publication path. The
packet describes the validation exception and has no `approval` object. The
existing release receipt verifies GitHub approval and binds the exact packet.
Keep the original FRV run/attempt and sealed bytes. See
[fast-track publication](references/fast-track.md).
Use the bounded policy only within 20 commits AND 15,000 added/deleted lines
(package manifests and enumerated lockfiles excluded from LOC only; beta
prereleases are exempt and need no reference release, but their stable
promotion still needs a passing stable FRV), or the
separate partial-FRV policy with its complete outstanding-check snapshot.
Neither policy creates a fully validated baseline. An admitted publication may
finish after expiry only through its original packet-bound receipt and verified
approval-job start timestamp; expiry never authorizes a new publication.

## Shared release boundaries

Use the [owner lifecycle's authority defaults](references/release-owner.md#resolve-authority)
for release-management requests: beta includes validated publication unless
held; stable and extended-stable require publication approval. An explicit
prepare-only request never authorizes publication. An explicit instruction to
publish or complete a named release carries through its validated publication
and verification; do not ask again unless identity, channel, scope, or material
risk changes. Resolve and record the version before changing it; unspecified
versions follow the lifecycle's approval rule. Ship authority for ordinary code
is not release authority.

Before managing or changing a release, read
[the lifecycle boundaries](references/lifecycle-boundaries.md) in full.
Before choosing, running, interpreting, recovering, or accepting validation or
publication proof, also read [the validation boundaries](references/validation-boundaries.md)
in full. These shared rules apply alongside the selected operation reference.
