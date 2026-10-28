---
name: release-openclaw-maintainer
description: "Manage one OpenClaw release or orchestrate release owners across beta, stable, and extended-stable: preparation, hotfix routing, publication, handoff, and closeout."
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
- Backport discovery: [candidate inventory](references/backport-discovery.md). For extended-stable also read [backport preparation](references/extended-stable-backports.md); SDK/config changes need a visible maintenance-risk warning and maintainer decision.
- Extended-stable `.33+` Gateway publication: [extended-stable publication](references/extended-stable-publish.md). Use the shared publisher with extended-stable inputs; its non-Latest GitHub Release carries evidence without native-app or ClawHub publication.
- Validation selection or failed proof: [validation and confidence](references/validation.md), with `$release-openclaw-ci` for workflow execution and immutable manifests.
- Interrupted publication or registry promotion: [publication recovery](references/publication-recovery.md).
- Native assets: [platform publication](references/platform-publication.md), with `$release-openclaw-mac` for macOS operations.
- Stable postpublish synchronization and the exact-SHA deployment handoff:
  [main closeout](references/stable-main-closeout.md).
- Release retrospective and shared issue ledger (every track, and any handoff
  snapshot): [retrospective](references/retrospective.md).
- Release notes: `$openclaw-changelog-update`, including its separate approved post-release docs-mirror route. Initial release generation keeps its existing format; docs publication does not run automatically during release. Requested announcements: `$release-openclaw-announcement` for Discord, `$release-tweets` for X. Announcements never gate publication and require explicit posting authorization.
- Published artifact verification: `$verify-release`. GHSA operations: `$openclaw-ghsa-maintainer` only with explicit security-workflow authorization.

## Hotfix ledger management

Prefer the [shared hotfix ledger](references/hotfix-ledger-management.md) for
backport discovery, selection, and outcomes, including Tideclaw-owned releases.
Reuse candidates, add discoveries from main/sibling releases, and update each
release's assessments. If access is unavailable, keep local evidence and sync
later. This is recommended bookkeeping, not another release gate.

## Shared release boundaries

FRV must conclude **success** under pinned P's
[checked-in release-tooling policy](../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers).
Only exact failed live-provider or Telegram leaves may be waived, without
skipping tests or changing C/Q. All other required lanes must succeed: Windows
and macOS Node and other normal CI jobs, install smoke, survivor
lanes, `update-first-hop-compat*`, pack/npm qualification, package integrity,
and Linux/Windows/macOS Gateway checks, including Windows packaged
install/upgrade checks in Release Checks. A cancelled run still blocks. Preserve
first failures and classify each one as below before recovery. Stable
publication requires stable/full evidence, soak, and blocking performance.
Beta-profile evidence cannot authorize stable publication. None of those hard
gates, soak, or performance can be waived. All nine Gateway install/upgrade
combinations across Linux, Windows, and macOS are required for all-group
qualification. Preserve identity, provenance, complete evidence, and existing
publication approvals.

Every failed test gets an explicit lead decision, real release blocker or
flake, recorded in the handoff with its evidence: the same SHA passing
elsewhere or on rerun, no relation to the release delta, a runner or infra
signature, a history of the same case flaking, or a pre-existing product bug
that is not a regression (for example the 2026.9.6 "Assign to…" bug). A real
blocker is a regression in shipped bytes or behavior, or an update/install/
publish defect; fix it on the release branch. Rerun a flake on
the same Release SHA with at most two recorded reruns by default, and file a
fix-in-parallel issue or PR on `main` with the evidence. Never re-cut for a flake.
A deliberate tooling-code waiver requires FRV validation under the new pinned P,
not a publisher override. An unwaived flake that remains red blocks publication.
Main-only failures and infrastructure
failures (runner outages, GitHub ghost jobs, hosted-runner offload) count as
flakes for the release.

Dependency advisories never delay a release. A newly published advisory is
never a reason to re-cut, change tooling, or rerun validation. Record it in the
release evidence and handoff, then file or queue the dependency bump on `main`
as a normal follow-up after publication. Only a known-malware finding stops
publication. Release dependency evidence and release-dispatched CI enforce this.

Main's CI health never gates a release. Validation and publication run from the
release branch plus pinned tooling, so a red `main` is not a reason to wait,
re-cut, or pause. When the release needs a release-tooling fix on `main`
(tooling SHAs must be trusted `main` commits), `main` failures the fix does not
cause must not hold that landing: prove on a clean `main` checkout that the
failure already exists there, record it in the PR body, and merge. During an
active release, an admin merge is allowed for a release-tooling PR in exactly
that situation. Red `main` still gets fixed, in parallel by a separate lane,
never on the release's critical path.

The operating objectives are approximately 20 minutes to seal validation and
publication within an hour, not measured guarantees. Source-only children start
alongside artifact producers; candidate consumers start as soon as the candidate
is ready. Independently sealed green children can be reused for the same exact
target and inputs even when their parent failed, was cancelled, or remains active;
verify their original admitted qualification identity (or historical trusted-main
workflow SHA) and current attempt. The sealed
manifest supplies the SDK evidence digest and npm publication decisions; it
never acknowledges SDK API changes, so supply
`plugin_sdk_api_acknowledgement` whenever the SDK report contains changes. The
publisher accepts only successful FRV and cannot grant a waiver. Explicit
publisher inputs select publication scope; the candidate helper still validates its explicit
SDK acknowledgement when needed.

Use the [owner lifecycle's authority defaults](references/release-owner.md#resolve-authority)
for release-management requests: beta includes validated publication unless
held; stable and extended-stable require publication approval. An explicit
prepare-only request never authorizes publication. An explicit instruction to
publish or complete a named release carries through its validated publication
and verification; do not ask again unless identity, channel, scope, or material
risk changes. Resolve and record the version before changing it; unspecified
versions follow the lifecycle's approval rule. Ship authority for ordinary code
is not release authority.

An operator's explicit approval to do whatever is needed to prepare a named
release is standing authority for the necessary preparation decisions and
repairs. Carry it through candidate and tooling fixes, upgrade/migration design,
reviewed test or security-inventory alignments, isolated proof, commits, pushes,
and validation recovery. Record the decision, its evidence, and the selected
support contract; do not ask again merely because an already-approved class of
work reaches an implementation or verification step. Continue independent work
while resolving a blocker. This authority does not permit hiding defects,
lowering a gate to manufacture success, destructive changes to operator state,
unrelated work, or publication. A prepare-only request still requires a separate
publication instruction before releasing artifacts or a bridge version.

Keep one compact state record using
[the handoff template](references/release-handoff-template.md): effective goal,
version/tag/branch, cut/Code/Release SHAs, C/Q/P identities, active parent run and attempt,
successful child artifacts, approved changes, phase and next action. Latest
operator steering replaces superseded scope. Completed evidence stays complete
until a named change invalidates it.

For regular releases, prepare complete notes before freezing **Code SHA** when
possible. If those notes are final, **Code SHA and Release SHA are the same
commit**: one successful fresh full qualification can supply both roles and
their exact publication bytes. Do not create another commit or run solely to
separate the labels. If notes change after qualification, a descendant whose
complete delta includes `CHANGELOG/<version>.md` (exact beta version or stable
base) and only that entry, its
matching record, and root index may use `split-changelog-release-v1`
to reuse product proof while qualifying new publication bytes. Any other
source delta, rename, or deletion returns to the Code SHA loop. Historical
root-only receipts retain `changelog-only-release-v1`.
New test qualification freezes **Q=C**: the candidate's test workflow closure
belongs to the candidate. Keep independently trusted **P** (admission, aggregate
decision, verifier, and publisher) separate. A Q harness repair requires a new C/Q and newly bound
evidence; P-only or infrastructure repairs can preserve the candidate. Missing
qualification contracts need a deliberate backport, never future-main fallback.

Once a candidate is cut, its base is the operator's decision. Never re-cut
(re-base the candidate on newer `main`) unless Peter explicitly asks for it in
that release. Without asking, cherry-pick already-merged `main` commits onto
the release branch only to fix a confirmed release blocker: a required lane
failing deterministically on the frozen candidate, or an update/install/
publish-bytes defect. Name each cherry-pick in the handoff record. Not allowed:
opportunistic backports, feature reverts, or a new base taken to "pick up" a
fix that cherry-picks cleanly enough with a small conflict resolution.
Explicit operator-approved additions follow the
[owner intake procedure](references/release-owner.md#prepare-and-admit-hotfixes):
record the changed scope and requalify the new candidate, never silently reuse
invalidated proof. A manager's opportunity notification is not that approval.

Release process improvements made during a release land on both branches.
Workflow, release-script, release-test, `RELEASING.md`, and release-skill changes
merge to `main` first, then get cherry-picked (`-x`) onto `release/YYYY.M.PATCH`
for the next candidate or patch. A qualification repair needed for this release
must land before freezing a new C/Q; never silently swap the harness for an
already qualified candidate. Where `main`-only CI infrastructure is missing on the branch,
keep the branch's expression form and port only the logic. Product code on the
release branch stays blocker-only per the rule above.

Resolve every repair PR opened for the release before the final report. The
retrospective PR described below is the required open closeout deliverable, not
an unresolved repair. List every PR created during the release (`gh pr list --author
@me --state open` plus any PR bound to the session) and land or explicitly close
each repair PR with a reason; confirm its fix is on `main` and, when it is release
tooling, on the release branch. Also remove the release's temporary worktrees,
abandoned local cut branches, and stale `scripts/pr` worktrees. Then write the
[retrospective](references/retrospective.md) and open its `openclaw/maintainers`
PR with the issue-ledger update; keep a findings notes file from the start of the
release so it can be written from evidence.

Published versions and final tags are immutable. Reuse successful exact-source
artifacts; do not rebuild or republish as an implicit retry. The active release
is the work queue: no opportunistic moving-main fixes or backports. Classify
failures, repair their owner, retry the affected surface, then reassess rather
than repeating the full release.

Required publication proofs and enforced environment approvals remain required.
A passing sibling cannot replace missing required evidence. npm + ClawHub is the
priority path. macOS, Windows, Linux, and Android native publication runs in
parallel and never gates npm/ClawHub, GitHub release finalization, or main closeout.
Selected Windows Node, Linux/Windows/macOS Gateway, and native-app CI failures
block release validation. Platform publishers retain their own artifact
and updater contracts; report pending platforms and proof gaps accurately.
