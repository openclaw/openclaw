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
The existing authoritative classic-protection absence gate remains mandatory:
generic REST 404s and permission-projected GraphQL nulls do not prove absence.
Missing policy-read capability is an external authority blocker, not an
implicit fallback or permission to elevate the writer.
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
