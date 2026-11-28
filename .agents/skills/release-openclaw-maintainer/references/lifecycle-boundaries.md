# Shared release lifecycle boundaries

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
[the handoff template](../references/release-handoff-template.md): effective goal,
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
New test qualification defaults to **Q=C**. An explicit assessed qualification
**Q** may instead be admitted through the candidate route while **C** retains
source, package bytes, version, and baselines. Keep independently trusted **P**
(admission, aggregate decision, verifier, and publisher) separate. A Q repair
requires a new request, admission, and successful parent, not a new C unless
product source changes. Missing contracts need a deliberate Q repair or candidate
backport, never a moving-main fallback. Follow the
[qualification-tooling recovery procedure](../../../../docs/reference/full-release-validation/dispatch.md#recover-qualification-tooling-without-changing-the-candidate)
and the CI skill's [C ≠ Q decision and command guide](../../release-openclaw-ci/SKILL.md#repair-release-tooling-without-changing-the-product-c--q).
Use new Q for changed qualification workflow/harness behavior, P for admission/aggregate/verifier/publisher
repairs, and new C only for changed product bytes. For a drained FRV with a sealing/collector
defect, first assess [receipt-backed aggregate recovery](../../release-openclaw-ci/SKILL.md#receipt-backed-aggregate-recovery):
a reviewed P-only repair may authenticate the original admission, C/Q, child receipts,
and unchanged artifact bytes without a fresh test run, even when same-parent continuation
cannot restore its plan. Require a successful authenticated recovery aggregate; never
relabel the original failed parent or bypass publication verification. Reuse the explicitly qualified
parent through the checklist's `--full-release-validation-run-id` and `--skip-dispatch`;
its `--workflow-sha` still selects P, and its fresh qualification defaults to Q=C.

Once a candidate is cut, its base is the operator's decision. Never re-cut
(re-base the candidate on newer `main`) unless Peter explicitly asks for it in
that release. Without asking, cherry-pick already-merged `main` commits onto
the release branch only to fix a confirmed release blocker: a required lane
failing deterministically on the frozen candidate, or an update/install/
publish-bytes defect. Name each cherry-pick in the handoff record. Not allowed:
opportunistic backports, feature reverts, or a new base taken to "pick up" a
fix that cherry-picks cleanly enough with a small conflict resolution.
Explicit operator-approved additions follow the
[owner intake procedure](../references/release-owner.md#prepare-and-admit-hotfixes):
record the changed scope and requalify the new candidate, never silently reuse
invalidated proof. A manager's opportunity notification is not that approval.

All release channels, including extended-stable, backport applicable release
tooling and validation changes regardless of product-hotfix severity. Release
process improvements normally land on both branches, except independent
qualification-only repairs and Q-only grant data as described below.
Executable workflow, release-script, release-test, `RELEASING.md`, and release-skill changes
normally merge to `main` first, then get cherry-picked (`-x`) directly onto the
canonical release branch for the next candidate or patch, without a backport PR.
Urgent release-first repairs follow [the new-fix route](../SKILL.md#backports-and-new-fixes).
A qualification-only repair can instead land
in a reviewed independent Q and be newly admitted against unchanged C; no
release-branch cherry-pick is required solely to update tooling. Never silently
swap the harness or relabel an already qualified candidate's evidence. Where `main`-only CI infrastructure is missing on the branch,
keep the branch's expression form and port only the logic. Product code on the
release branch stays blocker-only per the rule above.

Resolve every repair PR opened for the release before the final report. The
retrospective PR described below is the required open closeout deliverable, not
an unresolved repair. List every PR created during the release (`gh pr list --author
@me --state open` plus any PR bound to the session) and land or explicitly close
each repair PR with a reason; confirm its fix is on `main` and, when it is release
tooling, on the release branch when the selected Q=C route requires it. Also
remove the release's temporary worktrees,
abandoned local cut branches, and stale `scripts/pr` worktrees. Then write the
[retrospective](../references/retrospective.md) and open its `openclaw/tideclaw`
PR with the issue-ledger update; keep a findings notes file from the start of the
release so it can be written from evidence.

Published versions and final tags are immutable. Reuse successful exact-source
artifacts; do not rebuild or republish as an implicit retry. The active release
is the work queue: no opportunistic moving-main fixes or backports. Classify
failures, repair their owner, retry the affected surface, then reassess rather
than repeating the full release.

Required publication proofs and enforced environment approvals remain required.
A passing sibling cannot replace missing required evidence. Successfully publish
selected npm plugins before core npm. ClawHub publication starts at its existing
dispatch point but runs independently from then on: planning, authorization,
dispatch, publication, verification, and recovery never gate core npm, GitHub
release finalization, main closeout, or the retrospective PR. Retain a separate
owner, run/attempt, status, and follow-up for pending or failed ClawHub work; do
not report it as complete. macOS, Windows, Linux, and Android native publication
also runs in parallel and never gates npm/ClawHub, GitHub release finalization,
or main closeout.
Selected Windows Node, Linux/Windows/macOS Gateway, and native-app CI failures
block release validation. Platform publishers retain their own artifact
and updater contracts; report pending platforms and proof gaps accurately.

For public-safe approval evidence, follow [public request packets](../references/fast-track.md#public-request-packets).
