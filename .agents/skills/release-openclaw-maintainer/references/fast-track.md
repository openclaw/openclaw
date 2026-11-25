# Fast-track release approval

Fast-track approval is an explicit validation exception in the existing release
publication path, not a separate release pipeline. Parent, npm/plugin, Docker
and stable closeout consumers retain source, artifact and publication-approval
checks. The `authorized-beta-focused-v1` evidence mode remains supported.

## Approval model

The sole approval gate is the existing GitHub Actions `npm-release` environment,
reviewed by an eligible npm release manager. In the release publish run, choose
**Review deployments**, select **npm-release**, then **Approve and deploy**.
That decision authorizes the exact workflow inputs, including the validation
exception. `scripts/release-approval-receipt.mjs` verifies the environment approval
history and binds the exception packet to the publication receipt.
This replaces the duplicate conversation/approval-URL gate that blocked fast-track
release use ([#204820](https://github.com/openclaw/openclaw/pull/204820)).

There is no separate fast-track approval service, Firebase record, chat/group
conversation, issue comment, approval URL, or manually supplied approver/time.
Do not ask the requester to create one. Agents may prepare exception evidence
and dispatch within their task authority, but must never approve the GitHub
environment using a human's token. Leave that approval to the release manager.

## Prepare a request

```sh
pnpm release:publish-preflight fast-track request --request request.json
```

This local-only command validates the request and prints its canonical payload
and digest. It does not approve publication, contact a service or dispatch a
workflow. Assemble the packet below from the request and digest; do not add an
`approval` object. Preflight and artifact preparation do not require a separate
human chat decision. Publication still waits for the GitHub environment approval.

The contract in `scripts/lib/release-fast-track-contract.mts` binds repository,
release tag/channel, candidate commit, published reference release/commit and
complete delta (both omitted for beta prereleases), policy, exact artifact digests,
publication scope, run/attempt, lowercase UUIDv4 request ID, expiry and explicit
action. Canonical serialization sorts artifacts and scope before hashing.
Persist the exact packet with release evidence; a digest alone is not approval.

## Publication policies

- `approved-fast-track-v1`: **at most 20 commits AND 15,000 total added/deleted
  lines** since a published ancestor release that was not itself fast-tracked.
  The publisher checks only that the reference GitHub release is published, not
  a draft, targets the reference commit and carries no fast-track assets. It does
  not replay the reference's historical validation evidence: shipping already
  passed that release's own publication gates. Exclude only files named
  `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `bun.lock` or `bun.lockb` at any depth from LOC. All commits still
  count, including dependency-only commits. Count other generated files. Blob
  integrity checks still cover excluded files. Reject binary, submodule and otherwise unmeasurable
  changes or shallow history. A previous fast-track cannot reset the baseline.
  The Git-backed helper recomputes the delta; a typed reference assertion is not
  authenticated evidence.

  **Beta prereleases** (`vYYYY.M.P-beta.N`) have no commit/LOC ceiling and need
  no preceding non-fast-tracked beta or other reference release. Omit
  `reference` and `delta`; the contract rejects them for betas. A final version
  published to the `beta` dist-tag is not a beta prerelease and keeps the
  ceiling. A fast-tracked beta never qualifies its stable promotion: the final
  needs a passing `release_profile=stable` FRV (`rerun_group=all`, soak,
  blocking performance), either fresh or reused from a beta FRV that itself
  passed. Build-only or failed beta evidence is not reusable. A stable
  fast-track remains its own exception, measured from a non-fast-tracked
  release; a fast-tracked beta cannot be its reference.

- `approved-partial-frv-v1`: separate explicit action **Approve publication with
  incomplete validation**, with no delta ceiling. Bind the reason, original FRV
  run/attempt and candidate, durable snapshot URL/digest, result summary and every
  outstanding check/job/run/attempt. Preserve original successes, failures and
  incomplete results. Do not relabel a failed FRV as successful. A partially
  validated release cannot reset the fully validated baseline.

Approval never waives package/build integrity, artifact identity, signing or
publication authorization. Publishers retain original FRV evidence and record
**validation skipped by approved fast-track**, not fictional success. An artifact
that was never built and sealed successfully cannot be authorized by approval.

## Prepare artifacts without validation

When the explicit maintainer instruction is to fast-track, do not run a full
validation cycle merely to obtain artifacts. Use the existing isolated FRV
dispatcher with `-f rerun_group=build-only` and the normal exact candidate,
publication-selection and C/Q/P admission inputs. This mode builds and seals
npm, plugin and Docker publication artifacts but does not dispatch CI,
prerelease, release-check, live, soak or performance validation. npm source,
SDK, dependency and contents validation also stays skipped. Build/package and
artifact-integrity checks remain mandatory. Do not use the normal full-validation
checklist to prepare a fast-track.

```sh
node scripts/full-release-validation-at-sha.mjs \
  --sha <C> --target-ref <release-branch> --workflow-sha <Q> \
  --admission-workflow-sha <P> --admission-workflow-ref main \
  -f validation_purpose=publish -f rerun_group=build-only \
  -f release_profile=stable -f publication_selection_json="$PUBLICATION_SELECTION"
```

Use the actual intended publication selection and release profile, as in the
normal admission flow. This example does not grant dispatch or publication
authority.

Both the independently admitted qualification tooling Q and trusted publisher
P must contain build-only support. For an older candidate C, select a reviewed
Q containing this support rather than changing C or falling back to
`rerun_group=all`. Unsupported tooling is a blocker, not permission to start
hours of validation. No build-only dispatch or publication is authorized by
this instruction alone; retain the explicit human fast-track direction.

Wait for successful artifact preparation. The dispatcher and `pnpm frv verify`
report preparation separately from validation. Retain the immutable manifest,
which honestly records skipped validation, then prepare the exact exception
packet against its run/attempt and sealed artifacts. Build-only evidence is
never normal successful-validation evidence, reusable qualification or a fully
validated baseline. Publish only through the existing fast-track approval path
below. Failed builds or missing seals still block publication.

## Publish through GitHub environment approval

Keep `release_evidence_mode=full-release-validation`. Supply one additional
`fast_track_request` JSON input to the existing publisher; the preflight helper
reads that JSON from a local file:

```sh
pnpm release:publish-preflight \
  --tag v2026.11.9 \
  --full-release-validation-run-id <original-frv-run-id> \
  --full-release-validation-run-attempt <original-frv-attempt> \
  --workflow-sha <trusted-publisher-sha> \
  --npm-dist-tag latest \
  --fast-track-request fast-track-request.json
```

The normal preflight prints the dispatch command with the exception packet
included. Dispatch only within the separately granted publication authority.
Do not change the candidate, rebuild publication artifacts, or replace the
original FRV merely to fit the exception.

The packet contains:

- `request`: the immutable `FastTrackRequest` describing this validation exception.
- `digest`: `fastTrackRequestDigest(request)`, including its `sha256:` prefix.

Publishers compare the request with independently authenticated candidate,
original FRV attempt, admitted publication selection and sealed artifacts:

- `request.run` is the original FRV run and attempt, not the publisher run.
- `request.artifacts` is exactly one entry named `publication-artifacts`, with
  the `sha256:` digest of canonical `manifest.publicationArtifacts` JSON.
- `request.publicationScope` is exactly one string,
  `publication:sha256:<hex>`, binding canonical
  `manifest.sourceAdmission.publicationSelection` JSON.
- For partial-FRV, `validationSnapshot.evidenceDigest` binds canonical original
  manifest JSON. Its counts and enumerated outstanding checks must match the
  parent and selected child jobs for the bound attempts. Preserve the snapshot
  and original run even when the human accepts those failures.

Use the canonical JSON serializer used by the release evidence owner, not
whitespace-sensitive pretty-printed files, when computing manifest, artifact
and selection digests. A caller-supplied digest or summary is not authenticated
evidence.

The original FRV manifest remains unchanged, including failed or incomplete
results. Retain the exception packet separately with the release evidence;
postpublish, recovery and closeout must use that same publication binding.
Neither approved policy establishes a new fully validated baseline. Without a
packet, the ordinary strict validation requirements still apply.

### Expiry and replay

The request must be unexpired and bound to unchanged contents when the
GitHub environment-approved publication starts. An already admitted publisher may finish after expiry;
recovery and closeout reuse its exact original packet only through the existing
publication receipt. The receipt binds the full packet digest and its verified
approval-job start timestamp must precede request expiry. An expired packet
cannot start an unrelated publication. Do not edit timestamps or substitute a
new request for already published bytes. Missing original receipt or mismatched
publication identity blocks replay. Docker retries and closeout must carry the
original admission attempt, not the parent run's newest attempt. Prepared-button
verification uses the recorded publisher run and attempt; fresh dispatch remains
subject to current expiry.

## Manual checks (not CI)

```sh
node scripts/run-vitest.mjs run --config test/manual-release-approval.config.ts
```

The suite stays outside normal CI discovery and refuses execution with `CI` set.

## Public request packets

Request packets are public release evidence. Include only public-safe risk
reasons and artifact/validation evidence. Do not include private conversations,
credentials or access-bearing URLs. The GitHub environment history and existing
publication receipt are the approval record, not a chat permalink.
