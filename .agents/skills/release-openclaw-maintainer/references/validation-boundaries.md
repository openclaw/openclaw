# Shared release validation boundaries

Absent an explicit [approved fast-track](../SKILL.md#fast-track-publication-uses-github-approval),
FRV must conclude **success** with trusted P evaluating pinned Q’s
[checked-in release-tooling policy](../../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers).
Record the approved release version, child role, and short reason. Include a
candidate SHA only for candidate-specific approval. Name a job to waive only
that job, regardless of outcome or whether it ran. Optional `step` narrows the
grant to that job’s first incomplete or failed step. Omit `jobName` to waive
all descendants of the role without dispatch, lookup, reuse, or a receipt.
Record the exception separately from a pass, keeping raw outcomes unchanged.
See [#204382](https://github.com/openclaw/openclaw/pull/204382): cancellation in
[Performance 45327586533](https://github.com/openclaw/openclaw/actions/runs/45327586533)
blocked [FRV 45326913251](https://github.com/openclaw/openclaw/actions/runs/45326913251).
Before committing a grant, stage the ledger in Q. From that checkout, run
`node "$REVIEWED_TOOLING/scripts/lib/release-validation-waivers.mjs" --check-staged`,
where `REVIEWED_TOOLING` is the absolute path to a reviewed checkout with the current
waiver checker. Require `Staged release waiver selectors are supported.` Older
copies can exit silently. Check the approved scope against the observed failure separately.
For grant-only edits, reuse the policy tests; add cases only for new matching or
validation behavior. Keep new reasons to one sentence and authorization details
in the release handoff, not public Q data or published docs ([#199776](https://github.com/openclaw/openclaw/pull/199776)).
Commit authorized grants directly to Q’s `scripts/lib/release-validation-waivers.json`;
no grant PR to `main`, no grant cherry-pick into C. Pin the new Q in a fresh
request/admission, then reevaluate eligible raw successful/failed receipts under
its grants. The ledger-only delta preserves workload identity; executable Q
changes do not. Public Q branches are not private storage.
A grant does not change C. All unwaived required lanes must succeed: Windows
and macOS Node and other normal CI jobs, install smoke, survivor
lanes, `update-first-hop-compat*`, pack/npm qualification, package integrity,
and Linux/Windows/macOS Gateway checks, including Windows packaged
install/upgrade checks in Release Checks. A cancelled FRV parent still blocks. Preserve
first failures and classify each one as below before recovery. Stable
publication requires stable/full evidence, soak, and blocking performance.
Beta-profile evidence cannot authorize stable publication. Hard gates and soak
remain mandatory; performance exceptions are limited to the checked-in policy.
All nine Gateway install/upgrade
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
A deliberate grant requires FRV validation under the new pinned Q,
not a publisher override. An unwaived flake that remains red blocks publication.
Main-only failures and infrastructure
failures (runner outages, GitHub ghost jobs, hosted-runner offload) count as
flakes for the release. A job that passed in the previous run and is unlikely
to be affected by intervening changes is presumed flaky, unless its failure
indicates a race that could affect production users. Apparent infrastructure
failures and test flakes may use the full bounded retry budget until contrary
evidence establishes a deterministic defect or production-impacting race;
repeated failure alone is not that evidence. Record the prior run and input
comparison; exact-same-SHA success is not required for this classification.
Follow the CI skill's [retry and proactive cancellation rules](../../release-openclaw-ci/SKILL.md#parent-ownership-and-cancellation)
when a deterministic repair makes the current FRV obsolete.

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

Follow the [FRV wall-time loop](../../release-openclaw-ci/SKILL.md#keep-frv-off-the-idle-path):
start remote validation promptly, repair failures as diagnostics drain, and
minimize downtime between cycles. Include every known non-flake fix affecting
the next run rather than knowingly carrying failures forward; overlap useful
local checks with remote validation. Consider [broad CI discovery alongside initial FRV](../../release-openclaw-ci/SKILL.md#optional-broad-ci-discovery-alongside-initial-frv)
to reuse existing failures and batch repairs without delaying the initial run.
This guides scheduling, not new gates.

The operating objectives are approximately 20 minutes to seal validation and
publication within an hour, not measured guarantees. Source-only children start
alongside artifact producers; candidate consumers start as soon as the candidate
is ready. Independently sealed green children can be reused for the same exact
target and inputs even when their parent failed, was cancelled, or remains active;
verify their original admitted qualification identity (or historical trusted-main
workflow SHA) and current attempt. The sealed
manifest supplies the SDK evidence digest and npm publication decisions; it
never acknowledges SDK API changes, so supply
`plugin_sdk_api_acknowledgement` whenever the SDK report contains changes.
Review the diff and acknowledge it yourself; stop for the operator only if a
change looks harmful. The
publisher accepts successful FRV or an exact human-approved fast-track packet.
It does not grant ad hoc waivers or relabel failed validation. Explicit
publisher inputs select publication scope; the candidate helper still validates its explicit
SDK acknowledgement when needed.
