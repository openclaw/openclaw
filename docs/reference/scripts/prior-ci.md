---
summary: "Exact evidence and authority requirements for prior-CI admin landing"
read_when:
  - Investigating or maintaining prior-CI admin admission and inherited-failure evidence
title: "Prior-CI admin admission"
---

# Prior-CI admin admission

PR CI is the default broad proof. Do not rerun or re-push just for green. Fix real failures and read CI's published failure classification before attributing a red. The exception below still requires exact evidence and live authority.

The explicit `merge-run --admin-evidence <file> --confirmed-operator-admin` mode
is a separate immediate-squash admission, not a fallback from auto/queue or a
failed request. It verifies a prior successful CI attempt and its PR/head
provenance, binds the reviewed prior-to-prepared delta and scoped-check
attestations, and revalidates active organization/repository-admin authority and
effective review rules. For attributed pre-existing failures only, it also
accepts repository write access plus active organization membership and the
actual writer's live `always`/`pull_requests_only` bypass of every effective
repository-owned CI-only ruleset. The ruleset must contain only GitHub Actions
`openclaw/ci-gate`; mixed review/security policy cannot delegate this exception.
Policy and grants are rechecked after CI/security inspection and retained with
the existing outcome. Scoped land authority includes this inherited-failure
exception; the confirmed-operator flag records that scope without asserting that
the bot is an administrator. No grant changes or alternate credentials occur.
Classic branch-protection discovery is not a prerequisite for landing. The
helper does not request `/branches/main/protection`, infer its absence from a
404, or require administrator access merely to inspect it. Applicable rules
supply required-check, review, and delegated CI-bypass evidence. The admin route
also pages GitHub's native per-PR required-check markers, bound to the prepared
head on every page. Requirements absent from the ruleset inventory use the
existing latest-run and publisher checks; failed, pending, or missing results
remain blocking. Optional failures and superseded runs do not become required.
These observations do not attest that an unreported classic requirement is absent.
GitHub evaluates the writer's actual permissions and applicable enforcement at
the exact-head merge request. A provider refusal is retained and investigated
under normal recovery, never retried through another writer or treated as
permission to change credentials.
Repository write access, organization membership, CI bypass, release environment
approval, and production deployment authority remain separate capabilities.
The original conflict-resolution route permits only
pending/skipped `openclaw/ci-gate`. An explicitly approved `pre-existing-failure`
attribution instead binds the current failed attempt, effective gate check-run,
tested merge/base, unchanged failure inputs, and inspected qualification artifacts.
Planned PR jobs finish after sibling failures; cancelled coverage stays unrun.

Read `pr-failure-report` or `openclaw/ci-gate`: **pre-existing** with matching signatures needs no further attribution; for job-name-only **pre-existing**, check the failing tests against main before attributing the failure.

Historical cancelled runs retain their tested cancellation policy and require
complete job and cancellation accounting.
An independently attributed cancelled Node test,
`check-prod-types`, or real-Gateway UI root can use
`failures[].failedStep: { number, workflowJob }`, with
`checks-node-core-test-nondist-shard`, `check-shard`, or
`checks-ui-e2e-real-gateway`, respectively.
Admission binds its live check-run, complete steps, single failed execution step,
timestamps, and unchanged audited workflow. The production-type and UI routes also
match every declared source step and its ordered timeline. The UI route permits
only its explicit optional runner setup/cleanup pair and requires the successful
private-QA build before its audited test entrypoint. Other steps must
succeed or be skipped through successful cleanup.
Retain the cancelled conclusion in the root proof; this is not passing coverage.
A collateral cancelled job's failed step remains blocking except for
the verifier's retained historical skipped-producer/missing-artifact contract.
Its secondary evidence stays under cancellation, never
in the causal root list; test, cleanup, and upload transport failures remain blocked.
The review retains `tests.result: "fail"` with exact
`tests.preExistingCi` head/run/attempt attribution. Ordinary merge admission refuses
that review; the confirmed admin route must verify the same failed attempt.
Without a failed-step binding, an attributed cancelled Node root requires its
matching live GitHub Actions check-run and complete deadline/cancellation annotations,
consistent head/suite/timestamps, elapsed deadline, one cancelled test step, no
additional failed steps, and unchanged workflow. Retain that cancelled status in
the root proof; it is not fail-fast collateral or passing coverage. Manual or
unverified cancellation remains refused.
Branch-caused or unattributed failures, other required checks, security, and
required reviews remain blocking.
Exact-head `github_pending` preparation remains pending. GraphQL owns
observations and reconciliation; the [protected REST PUT](/reference/scripts/github-transport#octopool-string-rewrite-protection) owns the SHA-pinned
dispatch. The existing retained outcome owns `priorCiAdmin` evidence and retains
its baseline/prior head and tested merge objects. Exact PR/policy facts and the
landing-parent audit still apply; active prior-CI admission may accept verified
forward-main movement under the [merge admission contract](/reference/scripts/merge-admission). See the [landing workflow](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/landing.md#explicit-prior-ci-admin-landing)
for the evidence fields and supported policy limits.

## Artifact-build failure with successful primary CI

The same confirmed admin route accepts an independently attributed failure in
`.github/workflows/ci-build-artifacts-testbox.yml` when primary `ci.yml` passed
on the exact prepared PR head. This is the supported artifact-build contract;
it does not admit arbitrary secondary workflows.

Keep `runId` and `runAttempt` bound to the failed artifact-build run, including
`tests.result: "fail"` and the review's `tests.preExistingCi`. Add
`primaryCi: { runId, runAttempt }` naming the separate successful primary attempt.
Retain the ordinary tested merge, baseline, artifact hashes, per-job attribution,
and scoped passing checks. Every failure's unchanged `sourcePaths` must include
the artifact-build workflow itself. Omit `aggregate` and `cancellation`:
all artifact-build jobs must be terminal and none may be cancelled.

Admission binds the failed jobs to current optional check-runs, their suite,
workflow, and attempt. A newer PR run of the same workflow invalidates this evidence; older successful
or skipped runs do not.
Primary CI's gate and `security-fast`, the combined CI/security status, and every
current required check must pass. Security Review replay verification uses the
primary CI run and attempt. Other failed or unfinished rollup contexts remain
blocking; the ordinary watcher and cancellation contracts are unchanged.

A PR bound to older tooling with no retained merge outcome can explicitly select
current official-main tooling for this one confirmed admin invocation:

```bash
scripts/pr merge-run <PR> --current-workflow --admin-evidence <file> --confirmed-operator-admin
```

The native lock, fresh official-main acquisition, complete wrapper verification,
exact review/preparation/head checks, and existing writer authority still apply.
Any retained outcome or unresolved merge capture blocks first admission.
The original binding is unchanged. The outcome retains `workflowAdmission`
with the binding and old/new sources; ordinary reconciliation and completion
continue through the original workflow. The new tooling must land through the
existing trusted workflow before use. Never edit a binding or invent a recovery
outcome to select unlanded code.

## Requalification on a busy main

An admin attempt requalifies verified fast-forward main movement for up to 15
minutes and 32 rounds, reporting each round's elapsed time. A round must finish
before that deadline. Persistent mergeability recalculation has a separate
60-second settle window from the first UNKNOWN projection, with 2-second,
4-second, then 8-second backoff. Exhausting
either bound stops before retaining intent or dispatching a merge. In-flight
reads may finish after the deadline, but cannot admit a merge or start another
round.

Every round refreshes required checks and suites, review and security authority,
writer membership and bypass, and main. Independent GitHub reads run concurrently
with at most four child requests in flight. A REST qualification shares its one
complete check inventory between observation and verification; it is discarded
before the next round. Cancelled-root check-runs and annotations also stay fresh.
Completed historical attempt job data, tested-merge and source
object equality, the prepared-head delta, and operator evidence may be reused
only within the uninterrupted, lock-owning invocation and their pinned identities.

Historical proof precedes the shared check inventory and final main read.
Current review and security authority are verified afterward. Effective policy
is reread after that work, before the final writer check, so a CI-only grant
cannot waive newly tightened requirements. Local-only
verification proves main's ancestry and merge tree, checks overlap and
critical-path drift, and compares the Security Review publisher's protected
sources against that exact tip. Missing
objects require discarding live authority, materializing the exact tip, and
starting a fresh round. Approval revocation, new failing suites, changed publisher
sources, or non-fast-forward main movement still refuse admission. The reviewed
head, operation lock, and retained-outcome contract are unchanged.
