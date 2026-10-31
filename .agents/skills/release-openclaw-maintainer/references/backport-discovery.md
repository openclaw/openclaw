# Evidence-Driven Backport Discovery

Use this before selecting backports for any OpenClaw release line: regular
beta/stable, extended-stable, or a release-repair branch. It is an audit before the candidate is
mutated, not a title search and not permission to expand a frozen release.

## Start from the shared ledger

Start with [shared candidates and assessments](hotfix-ledger-management.md),
including carry-forward and sibling-release evidence; sync new findings and
decisions back. Empty/incomplete records do not replace the pinned inventory
or P0/P1 discovery below. Use local evidence when access is unavailable.

## Freeze the Audit

1. Pin the exact maintenance-line baseline and the exact `origin/main` SHA.
   Use the release branch/tag/package baseline that users run, not a moving
   local branch.
2. Resolve the last accepted, auditable scan cursor. If none exists, use the
   merge base of that baseline and the pinned main SHA. Histories without an
   auditable cursor or merge base require maintainer direction; never guess
   from dates, PR titles, or a previous abandoned release PR.
3. Enumerate every main commit since that cursor, then remove only commits
   proven patch-equivalent to the baseline. Account for merge, squash, direct,
   reordered, and companion commits; `git cherry` is evidence, not the final
   answer.
4. Reconcile authorized public and private security advisories before calling
   the inventory complete. Use the approved private advisory workflow for
   unpublished details. The public record may say only `pending` or `cleared`.

Keep a durable unreleased backport ledger with the staging evidence: scan
bounds and pinned SHAs, baseline identity, total/equivalent/non-equivalent
counts, filters, every candidate decision, applicability result, exclusions,
dependency groups, and carry-forward blocked items. Security rows in public
evidence must remain opaque; retain private identifiers only in the approved
security record. Keep scan bounds, counts, and the full commit inventory in the
existing staging evidence, linked from the service assessments; they need not
be separate API fields or one hotfix record per unrelated commit. The next
accepted audit uses that evidence's `scan_end` as its cursor.

## Reconcile Stable-Maturity Issues

At the pinned `origin/main` SHA, snapshot all OpenClaw issues carrying
`maturity:stable` and record the query time with the audit bounds. This is a
secondary completeness and priority check over the commit inventory, not a
replacement for it. The label means the current issue review matched broken
existing behavior to a primary M4/M5 scorecard surface; it does not prove the
issue, identify a complete fix, approve a backport, or block a release by
itself.

For each labelled issue, whether open or closed, whose fixing PR or commit
actually landed in the scan range, link that fix to its commit-ledger row and
require an ordinary `backport`, `already-covered`, `not-affected`, `blocked`,
or `skip` decision. Do not omit a commit based on its linked issue's state, and
do not add one merely because the issue has this label. For each open P0/P1
labelled issue, add a release-readiness disposition: fixed by the candidate,
not affected on the release baseline, explicitly deferred by a maintainer, or
blocked because no proven fix exists. Open issues without a merged fix are not
backport candidates.

Read the current review rationale before relying on the signal. If the issue is
a feature proposal, new config or policy request, docs/support work, or is
primarily owned by a below-M4 surface, record `label-drift` in the audit and do
not treat it as a maturity candidate. Release discovery reports drift but does
not mutate issue labels. Keep the underlying commit and security inventory
complete even when label data is missing, stale, or wrong.

## Find Reliability and Security Candidates

Do not use commit subjects, labels, or PR visibility as an inclusion gate.
Classify every non-equivalent commit in the ledger, and inspect the full
production diff for every security- or reliability-signalled item.

Search beyond explicit security terms. Separately review conventional
`fix`, `perf`, and `doctor` commits whose production paths touch execution,
authentication, sandboxing, networking, persistence, delivery, gateway,
configuration, plugins, or major channels. Benign titles, dependency bumps,
missing PRs, and broad batches can conceal operational fixes; they require a
decision with evidence, not a cursory skip.

For each such production diff, mechanically probe applicability against the
pinned baseline before judging it. Repeat `--candidate` to emit one TSV report
for the batch:

```bash
pnpm release:backport-probe -- \
  --baseline "$baseline_sha" \
  --candidate "$candidate_sha" > backport-probe.tsv
```

The helper uses `git merge-tree --write-tree` with the candidate's parent as
the explicit merge base, so it simulates that single patch without checking out
or resetting a worktree. The TSV binds the resolved candidate and baseline,
classification (`clean`, `conflicted`, or `already-covered`), conflict count,
touched-file count, every touched path, and whether that path conflicts. It
refuses root and merge commits whose cherry-pick mainline is ambiguous.

Record a failed probe with its exact reason. A clean probe is triage evidence
only; it does not approve a backport. If the commit needs companions, probe and
assess the smallest ordered final fix rather than treating each clean commit as
an independent candidate.

## Close Selected Contracts Before Qualification

Extend the same backport ledger; do not create another release-state store or
infer dependencies from commit titles. For each selected fix, record its
consumer, owning producer, public exports or generated inputs, and lifecycle
or recovery companions. Include workflow, script, fixture, and CI-planner
changes, not only product code. Trace the actual symbols and contracts in the
pinned main change and baseline; a clean cherry-pick does not prove closure.

Give each prerequisite one evidenced disposition: `present-equivalent`,
`selected` (with its ordered commit group), `missing`, or `not-applicable`.
Name source paths/symbols and commits, the baseline evidence, and focused proof
for the complete group. An equivalent implementation counts without the same
commit SHA. Missing or unverified prerequisites keep that group blocked; do
not start qualification hoping full CI will discover them.

Use the existing Git tools to locate companion changes:

```bash
git show <selected-main-sha> -- <consumer-path>
git show <baseline-sha>:<producer-path>
git log -p -S '<contract-symbol>' <pinned-main-sha> -- <producer-path>
```

Run the bounded companion audit for every selected commit. Repeat `--selected`
for an ordered group. Before picks, omit `--candidate`; after picks, supply the
final candidate so the report compares the selected main file set with the
actual baseline-to-candidate delta.

```bash
pnpm release:backport-companions -- \
  --baseline <pinned-maintenance-baseline> \
  --scan-end <pinned-main-sha> \
  --selected <selected-main-sha> \
  --candidate <final-candidate-sha>
```

Disposition every reported later same-path commit, later mention of the
selected PR number, existing neighbor test, selected-file reference/registry,
candidate file-set difference, and candidate content difference. A whole-file
difference is inspection evidence, not a failure: a release adaptation or the
final selected companion sequence can differ legitimately. This scan is
heuristic and never establishes dependency closure or approval: manually trace
symbols, callers, imports/exports, producers, workflows, registries, generated
inputs, and differently named or cross-directory tests. Record
`present-equivalent`, `selected`, `missing`, or `not-applicable` in the
existing backport ledger. Missing or unverified rows keep the group blocked.
Do not silence a candidate merely because it is not a dependency, and do not
automatically cherry-pick it.

Read callers and sibling consumers too. For an IPC-readiness consumer, check
that the baseline's fixture producer emits the expected receipt and preserves
any shell/file-readiness callers. For an imported fixture helper, check the
defining module and exported barrel together. Probe the ordered complete group
using the applicability procedure above, then run its focused owner proof;
neither importing a future-main helper nor weakening the consumer closes it.

Before freezing, compare the selected qualification workflows and planners
with their pinned-main counterparts for known CI deduplication and preparation
optimizations. Record each relevant optimization as already equivalent,
selected, deliberately excluded with rationale, or blocked. Compare the actual
scenario/input coverage and retained gates, not job names or duration alone.
For example, a removed self-upgrade aggregate is covered only when the
baseline's Package Acceptance selection still runs its required upgrade
scenarios. Check source-independent admission/Doctor preparation the same way;
do not cherry-pick unrelated optimizations automatically.

Present the closure rows and CI-optimization dispositions with the proposed
set before candidate mutation. After approved backports, recheck them against
the final candidate SHA before qualification: report complete groups, remaining
blocked groups, and deliberately excluded optimizations. Unresolved selected
contracts block freezing; excluding an optimization is not a waived test gate.

## Decide and Present the Set

For every proposed backport, inspect the complete change, baseline behavior,
callers, callees, sibling surfaces, tests, dependency contracts, security
impact, and the release publication surface. Collapse overlapping or dependent
commits to the smallest final fix. Mark already-covered, not-affected,
out-of-scope, and blocked items with the evidence that led to the decision.

Exclude features, migrations, new configuration, new runtime requirements, and
broad redesigns unless a maintainer explicitly approves their inclusion. Do not
substitute convenient dependency bumps for a complete candidate audit. A
backport is a cherry-pick of a merged `main` commit onto the release branch;
never re-cut the candidate from newer `main` to absorb one unless Peter
explicitly asks for it in that release. After dispatch, only confirmed release
blockers qualify, each named in the handoff record, unless the operator explicitly
reopens intake under the [owner lifecycle](release-owner.md#prepare-and-admit-hotfixes).
That decision invalidates affected evidence; it never authorizes publication of
untested changes.

Before changing release refs, present the complete categorized ledger and the
proposed set for maintainer approval. After approval, backport with provenance,
update the ledger, run focused proof plus the release-appropriate validation,
and keep the final branch/tag/version/SHA identity in that record. Dispatch npm
preflight only after the canonical release branch or tag has that exact final
version and SHA.

## Port with Bounded Workers

Read-only audit lanes may fan out. Porting lanes write to the release candidate
and share one host, so run at most eight concurrent writing workers, and do not
launch or resume workers close to a session usage limit. A worker does not
spawn its own agents unless its brief allows it. A 17-lane porting wave on
2026.10.8 saturated the Mac and lost 16 lanes mid-port when the session limit
hit. The lead keeps a watcher on every worker and never ends a turn waiting on
one; once the required fixes and P0s are integrated, push and dispatch
validation, and add stragglers in a later cycle.

Every porting brief contains these steps for each pick, in order:

1. Run the companion audit for the pick (`pnpm release:backport-companions`
   above) and `git log <pinned-main-sha> --grep '#<PR>'`. List each later
   follow-up and its disposition in the commit body. Missing follow-ups caused
   most 2026.10.8 validation failures, including a macOS regression found only
   after tagging.
2. Confirm the defect exists on the baseline (`git show <baseline>:<path>`)
   before porting.
3. Cherry-pick with `-x`, resolve conflicts, and note any adaptation as
   `Release adaptation:` in the commit body.
4. Run targeted tests and typechecks for the touched owners only. Wrap every
   local command in `timeout`; full local gates are not a worker's job.
5. Commit, then append the pick's result to the lane report before the next
   pick. Time-box a pick to about 40 minutes and report it as blocked rather
   than continuing past that.

Reuse the lead checkout's dependencies instead of a fresh install per lane when
the lockfile matches.
