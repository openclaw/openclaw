---
doc-schema-version: 1
summary: "Which Full Release Validation evidence to retain, blocking lane outcomes, and the backing workflow files"
title: "Evidence to keep"
read_when:
  - Recording release evidence after a validation pass
---

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. Classify failures as product,
harness/tooling/provenance, infrastructure/credential, or wrapper. Only a
confirmed product failure changes the Code SHA. Use one diagnosis, one fix when
needed, and one narrow retry, then reassess; do not automatically rerun `all`.
Narrow evidence is not publish authorization by itself.

Decide blocker or flake for every failed test. Every selected failure blocks
publication unless trusted P accepts an exact failed allowlisted lane through
the mechanism below. Waived evidence is never a successful test result.

Linux, Windows, and macOS Gateway cross-OS install and upgrade lanes are
required for beta, stable, and full validation. The manifest records their
actual conclusions, and failures block the release decision. Keep diagnostic
artifacts; never report a failed, omitted, or deferred lane as passed.

For a regular release, record Code SHA and Release SHA even when they are the
same commit. In that case, retain the successful full validation parent and
its exact prepared publication artifacts for both roles. For a later
changelog-only Release SHA using evidence reuse, also record the reuse policy,
complete changed-path set, green Code SHA parent run, and Release SHA parent
run. For extended-stable, record the release branch, exact release SHA,
accepted producer identity, parent run id and attempt, workflow ref, every child run, and any
frozen-target compatibility repair or intentional omission.

Useful artifacts:

- The attempt-one `full-release-execution-plan-<parent-run-id>` and current
  `full-release-validation-<parent-run-id>-<attempt>` manifest retain source
  facts and registry admission, including observations, exact selection,
  immutable upload identity, and admission-time freshness. Reuse retains distinct
  original and current records without restamping either. Authentication requires
  the original successful admission and guarded upload, not an overall successful
  sealer job: an interrupted sealer can still write and upload a complete plan.
  Later attempts never replace that original artifact.
- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, runtime parity, and selected Matrix, Buzz, Telegram, Discord,
  WhatsApp, or Slack artifacts

Readers authenticate retained evidence; they do not refresh registry observations
or expire it by the current clock. Registry admission is not publication authority
or a promise that registry state is unchanged. Final writers keep their own trust,
approval, content, and readback checks. Known enclosing evidence is budgeted before
fanout, but later job/attempt growth can still exceed the unchanged final artifact
limit and fail sealing; evidence is not truncated to fit.

## Publication waivers

The only grant path is trusted publication tooling **P**: the publisher input
`validation_waivers_json`, or `pnpm release:candidate --validation-waivers-json`
with an existing `--full-release-run`. It never edits the candidate or dispatches
an FRV. Candidate **Q** (`full-release-validation.yml`, checked out at
`github.sha`) has no waiver input and still runs Telegram in stable/full checks.

Declare one row per exact failed job. This historical Z.AI example illustrates
the shape; current authenticated attempts and outcomes must match before use:

```json
{
  "schema": "openclaw.release-validation-waivers/v1",
  "targetVersion": "2026.10.4",
  "candidateSha": "383c124cc32ffee3f8e56f549b88da94d269a4af",
  "parentRunId": "38774938703",
  "parentRunAttempt": 1,
  "waivers": [
    {
      "childRole": "releaseChecksIndependent",
      "childRunId": "38775999936",
      "childRunAttempt": 2,
      "jobName": "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
      "suiteId": "native-live-src-agents-zai-coding",
      "reason": "Third-party credential outage: Z.AI rejected the shared key (auth).",
      "approvedBy": "maintainer-login"
    }
  ]
}
```

Run IDs are strings; attempts are positive integers. Every tuple field must
match. `approvedBy` must be the authenticated operator with current repository
write/maintain/admin permission; bot children derive that operator from their
verified publication parent. Reasons and approvers are public release evidence.

From a trusted P checkout, save the declaration as `waiver.json` and run:

```bash
pnpm release:candidate -- --tag v2026.10.4 \
  --target-sha 383c124cc32ffee3f8e56f549b88da94d269a4af \
  --workflow-sha <trusted-P-sha> --full-release-run 38774938703 \
  --skip-dispatch --validation-waivers-json "$(cat waiver.json)"
```

The helper prints a direct publication command; it does not publish. The
prepared Release Button lacks an authenticated initiating-human handoff and
rejects waivers. For read-only verification, use:

```bash
node scripts/release-ci-summary.mjs --validate-run 38774938703 \
  --verifier-source-sha <trusted-P-sha> \
  --verifier-source-file scripts/release-ci-summary.mjs \
  --validation-waivers-json "$(cat waiver.json)" --json
```

### Allowed failures and hard gates

`scripts/lib/release-validation-waivable-lanes.json` lists exact child-role,
job-name and suite-ID pairs: native/Docker live third-party provider suites and
Telegram live/E2E. Wildcards are not accepted. Only terminal **failed** leaves
can be waived, never missing, skipped, cancelled, timed-out, active or successful
jobs. Authenticated carried-forward jobs retain their original accepted
attempt; the declaration pins the current child composite. Any extra unwaived
failure blocks publication.

Never waivable: normal CI/`openclaw/ci-gate`; npm/Docker/plugin artifacts;
pack/npm qualification; package integrity; install smoke; upgrade survivors;
`update-first-hop-compat*`; any Gateway install/upgrade combination; soak;
performance; plugin prerelease; or seal/evidence integrity. Beta confidence
deferrals remain a separate coverage policy, never a passing or waived result.

### Authentication without a success manifest

P's strict reader (`release-ci-summary.mjs` and `lib/release-validation-waivers.mjs`)
runs from `.release-validation-tooling` in the publisher and `trusted-workflow`
in npm, never candidate source. Shared publication-contract/policy/manifest
helpers project evidence but cannot grant a waiver during Q execution.

When failed aggregation prevented a success manifest, P authenticates the
original execution-plan artifact, archive digest, producer SHA/ref, successful
source admission, guarded upload and digest witness. Frozen pre-witness plans
keep their original upload-time binding. It validates terminal decision/drain
artifacts and re-reads complete GitHub job inventories, retaining existing
candidate seals, Q admission, tooling identities, dispatch, attempts,
carried-forward jobs, child reuse, required-job and performance checks.

Aggregate failures are accepted only when their exact failed steps and logged
causes are exclusively explained by the declared leaves. Non-waivable parent
preparation/qualification jobs and the artifact guard must succeed. The existing
recovery reader obtains the normal manifest writer's exact inputs from that
successful step's runner header; Docker's successful dispatch log supplies its
run/attempt. Existing publication consumers still authenticate producers and
qualified artifact bytes, SDK acknowledgement, registry selection and readback.

The P-side projection has no candidate success artifact (`artifact: null`). Its
parent stays failed and `allRequiredSucceeded` remains false; only
`allRequiredSatisfied` is true. Every consuming publisher reauthenticates the
explicit declaration. A file's `validationWaivers` field grants no authority and
cannot be reused as green evidence. Verifier output, evidence, summaries,
handoff and GitHub release body say **waived — not a pass**, with reason/approver.

Publication's final-effect authority callback rechecks both the original
qualification admission and the authenticated waiver approver before each
registry write, including Docker channel promotion. Stable closeout authenticates
the published declaration against the original publisher's exact input and
revalidates the failed FRV through the same strict reader; a serialized projection
alone cannot authorize closeout.

### Frozen branches and removal path

Already-cut `release/*` and active `extended-stable/2026.9.33` workflows retain
the retired input. P accepts empty recorded `telegram_waiver`/`telegramWaiver`
without rewriting authenticated bytes or digests. Non-empty values are rejected
with `validation_waivers_json` guidance: those version-wide omissions cannot
honestly become exact failed-job evidence. The helper likewise refuses new
non-empty legacy dispatches. No frozen branch is edited.

This compatibility exists only for supported frozen release/publication data.
Remove the optional legacy wire fields, digest allowances and no-grant guards
when the last eligible pre-cutover line and its recovery evidence retire; new
candidate producers emit none of them.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-candidate.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/install-smoke-reusable.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
- `.github/workflows/openclaw-performance.yml`
- `.github/workflows/npm-telegram-beta-e2e.yml`
