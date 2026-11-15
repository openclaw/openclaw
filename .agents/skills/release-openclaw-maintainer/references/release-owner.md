# Own a release from start to closeout

Use this lifecycle for “manage this release,” “prepare this release,” and
handoffs. Detailed commands and gates remain in the phase references linked
from [the skill](../SKILL.md). A longer kickoff prompt is optional.

## Resolve the release brief

Record channel, patch/feature, version, new/resume/handoff, source baseline,
publication scope and authority in the [handoff record](release-handoff-template.md).
Read current branches, tags, registry selectors, and any existing owner record
before changing state. Reconcile disagreement rather than guessing from a date.

**Patch** means hotfixes only, not a fresh main cut. **Feature** means advancing
the channel's baseline, not a SemVer major/minor promise or permission to add
unrelated features during stabilization.

| Channel         | Patch baseline                                               | Feature baseline                                                                                        |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Beta            | Current selected beta train plus approved hotfixes           | One pinned `origin/main` cut for a new beta train                                                       |
| Stable          | Selected previous stable release line plus approved hotfixes | Selected beta candidate plus approved hotfixes, then stable/full qualification                          |
| Extended-stable | Active maintenance line plus approved hotfixes               | Approved completed-month stable base plus approved hotfixes, establishing the eligible maintenance line |

Extended-stable “feature” is a baseline refresh, never weekly ingestion of main
or features into an existing maintenance line. Its month, retirement, bootstrap,
branch, and approval rules remain in [extended-stable preparation](extended-stable-backports.md).
An ineligible requested refresh needs a maintainer decision, not a guard bypass.

Use an explicit operator base or existing release record first. Otherwise use
the table and [version/channel resolution](preparation.md#version-and-channel).
Default an unspecified kind to patch when the selected channel has an existing
line; do not silently create a feature train when it does not. If channel is
unspecified, use beta per the skill. State these assumptions before mutation.
If version is omitted, resolve the next unused version from live state and
present it with the baseline; obtain approval before version/ref mutation unless
the operator already delegated version selection. Ask only for unresolved
consequential choices, and continue inventory or other read-only preparation.

Do not reset an existing release branch, reuse a consumed version, or replace a
final tag. A handoff adopts the existing base and candidate. New cuts follow
[preparation](preparation.md); re-cuts retain the skill's explicit approval rule.

## Resolve authority

Record the effective instruction, not just a boolean. Defaults for a request
to **manage** a release are:

| Request                                                            | Publication authority                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Manage a beta release                                              | Includes publication after required qualification; no second conversational approval             |
| Manage a stable or extended-stable release                         | Prepare and validate, then obtain explicit publication approval                                  |
| Prepare only, hold publication, or wait for approval (any channel) | Stop before publication until the operator releases the hold                                     |
| Explicitly publish or complete this named release                  | Carry that approval through validation, publication, recovery, and verification within its scope |

Specific operator instructions override defaults. “Cut” alone approves
preparation, not publication. The manager relays authority; it cannot invent it.
Publication approval survives handoff and same-scope recovery. A “next passing
FRV” instruction applies to the approved release and intake conditions, not an
arbitrary later candidate. A new channel, identity, scope, or material risk
requires a new decision. Tool access and green CI are not approval; enforced
signing and workflow environment gates still apply.

Carry explicit channel/contact restrictions and approved gate exceptions through
candidate changes and handoffs alongside that authority. A version-wide grant
remains scoped to that version; an attempt-bound grant does not expand to later
attempts. Resolve eligibility from pinned P’s checked-in policy, not a fresh
conversational approval or a blanket “performance cannot be waived” rule.
Distinguish required failures from advisory results using the selected coverage
and policy. Neither an advisory warning nor an optional confidence check creates
a new approval gate; an operator instruction alone cannot bypass enforced gates.

Before requesting stable/extended-stable approval, finish authorized preparation
and present the exact version, candidate/Release SHA, qualifying run, selected
surfaces, included/deferred changes, and remaining risks. Approval is the final
human step for that prepared result, not a reason to stop early. A request to
prepare only ends with this reviewable handoff, not a claim of publication.

## Prepare and admit hotfixes

Use [backport discovery](backport-discovery.md) for the bounded full-history
inventory and selected-contract closure. Assess applicable critical fixes even
when they conflict; be selective with lower-priority fixes requiring substantial
adaptation. Labels and titles are clues, never the whole inventory. Check fixes
shipped on sibling channels as well as main; prove equivalence on this baseline.
Major model launches are optional feature additions, not automatic hotfixes.
Extended-stable keeps its stricter SDK/config and maintenance-risk decisions.

Also make a bounded readiness pass over recent open issues and open PRs for
likely P0/P1 defects and regressions, including unlabeled reports. Record the
query window, baseline applicability, evidence, and disposition separately from
the merged-commit backport set. An open report is not automatically a blocker
or an approved backport. Route a confirmed missing fix to one main repair owner;
track its resolution or explicit deferral without repeatedly sweeping the backlog.

Record proposed, approved, included, deferred, not-affected, and blocked changes
in the [hotfix ledger](hotfix-ledger-management.md) when available, with
assessments for this release and links to the existing selection/proof evidence.
Use local evidence if access is unavailable; ledger synchronization does not
hold up the release. A hotfix opportunity is not inclusion approval. Follow
the approved selection scope; obtain the categorized-set approval required by
backport discovery unless that decision was already explicitly delegated.
Follow [backports and new fixes](../SKILL.md#backports-and-new-fixes) on every
track: reuse merged main fixes through individual direct backports, never
release-branch PRs. Prefer individual main PRs for new fixes; urgent release-first
fixes go directly to the branch with an owned post-release forward-port.

Make intake explicit:

- **Open preparation:** integrate each approved, dependency-closed group as it
  becomes ready while independent discovery continues; do not wait for unrelated
  audit lanes. Serialize changes to the canonical branch and record source and
  destination commits plus focused proof before taking the next group. Finish
  the complete inventory and resolve the final selection before freezing C/Q.
  If the operator requests early diagnostic validation while more backports arrive,
  record that it is provisional; it qualifies publication only if the final
  candidate and all required inputs remain exactly unchanged and eligible.
- **Frozen/validating:** new opportunities normally queue for the next release;
  only confirmed blockers enter under the shared release boundaries. An explicit
  operator instruction may reopen intake for named backports. Record which
  evidence is invalidated, apply the approved batch, and requalify its new C/Q.
  “Include these if a blocker already forces another candidate” is conditional:
  a flake or publisher retry does not satisfy it.
- **Qualified/publishing:** preserve the candidate and exact artifacts. A new
  product change returns to preparation and qualification before publication;
  after a final tag or published version, it needs a new version. Never smuggle
  changes into a publisher retry.

A manager notification alone does not reopen intake. Acknowledge the disposition
and reason so the manager can route the fix without polling or duplicate work.

## Run the validation and repair loop

Use the track's publication-capable profile and canonical `release-ci/*`
identity from [validation](validation.md) and `$release-openclaw-ci`. Stable
promotion needs stable/full evidence even when its beta was green. Preserve
C/Q/P, exact attempts, immutable artifacts, and mandatory prepush/source gates.

Follow the [FRV wall-time loop](../../release-openclaw-ci/SKILL.md#keep-frv-off-the-idle-path).
Keep one watcher for the active run and start repairs as failures arrive, not
when Diagnostic Drain ends. Aim to have all drained failures fixed on the branch
by drain completion, so the next cycle can start with little downtime. Include
all known non-flake fixes affecting that run rather than fixing one per cycle;
this is not a demand to rule out undiscovered failures. Keep useful surviving
diagnostics running while repairs proceed.

While a long lane or operator decision is pending, keep either the active FRV
or a named blocker/proof lane in flight. Pre-stage the next eligible FRV inputs
and run independent proofs, but do not dispatch a duplicate parent. If an
approved port is expected to land within about 15 minutes, wait for it before
dispatching so the run can qualify the resulting candidate. Ask decisions in a
non-blocking update with a recommended reversible default while independent
work continues. If the question remains unanswered, send one notification;
do not re-arm a watcher that has no new transition or work.

Apply the existing blocker/flake policy: diagnose first, repair the owner,
retry the affected surface within its budget, and retain successful exact-input
evidence where allowed. P-only, credential, or infrastructure recovery does not
change C/Q. A qualification-harness repair does. Do not scan moving main for
opportunistic additions or let unrelated red main CI become the release queue.

Keep the progress card compact: current validation/publication run link,
outstanding failures, fixing PR links, and the next action. Report unavailable
credentials or approvals as the exact blocked operation and required owner
action. Continue independent authorized work; do not repeatedly retry missing
authority, skip checks, or claim that dispatch completed the release.

## Publish, verify, and close

Once qualified and authorized, use the owning publication/recovery reference.
Verify the signed final tag before publication. Recover partial publication by
reconciling actual registry, workflow, and artifact state before retrying. Never
replace final tags or rebuild immutable published versions.

Track every selected surface independently in the handoff table. A successful
parent does not prove detached ClawHub or native-app completion. Preserve the
track's scope: extended-stable excludes native apps and ClawHub. Native
publication does not hold the priority npm/GitHub/main-closeout path. ClawHub
starts at its existing dispatch point and runs independently thereafter; its
authorization, failures, and recovery never block core or the closeout and
retrospective PRs. Pending work still needs an owner and an accurate status.

Finish the [hotfix ledger integrity check](hotfix-ledger-management.md#final-closeout-integrity-check),
`$verify-release`, required platform work, applicable
[main closeout](stable-main-closeout.md), and
[retrospective](retrospective.md), including its shared issue ledger. Keep
findings and operator corrections from the start, not only the final context
window. Resolve release-created repair PRs and cleanup under the shared release
boundaries; the retrospective PR is the explicitly required open deliverable.
Report verified artifacts, included/deferred fixes, evidence gaps, retrospective
PR, and any explicitly handed-off work. Do not call a pending handoff or
publication approval wait “released.”

## Resume or hand off

Keep the [handoff record](release-handoff-template.md) current at meaningful
phase changes. The outgoing owner stops new mutations and identifies any
in-flight operations before the successor takes over; never have two writers.
The successor acknowledges ownership and verifies remote branch/tag SHAs, live run
attempts, receipts, approval scope (including restrictions and gate exceptions),
pending fixes, and next action. Local tracking refs alone do not establish remote
freshness. Preserve frozen C/Q/P while reconciling; newer main is not a new cut.
Reconcile uncertain writes before retrying. A predecessor's credential failure is not a
reason to re-cut, rerun green proof, or discard publication approval.

Link the predecessor's record and frozen retrospective snapshot. Preserve
completed phases and successful evidence until a named change invalidates them.
If access still blocks a surface, name the precise external action needed and
continue the rest; a handoff changes the operator, not release identity.
