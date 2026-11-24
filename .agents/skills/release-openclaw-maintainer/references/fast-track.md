# Fast-track release approval

Fast-track approval is an explicit validation exception in the existing release
publication path, not a separate release pipeline. Parent, npm/plugin, Docker
and stable closeout consumers retain source, artifact and publication-approval
checks. The `authorized-beta-focused-v1` evidence mode remains supported.

## Approval model

Use the normal release-managers group and existing release approval process.

**An agent must never approve a fast-track release, including through a token
that happens to belong to a release manager.** Before taking any fast-track
action, obtain explicit approval from **a human in the release-managers
group**. That human may be the release manager who requested the fast-track;
an agent may prepare the request but never decide it. Generic release
ownership, permission to prepare/publish, silence, a previous approval or an
agent's interpretation of intent is not explicit fast-track approval.

The human must review the exact action, candidate, artifacts, scope, run/attempt,
expiry and request digest. Record the approver, explicit decision, timestamp,
permalink and exact request/digest alongside normal release evidence. The group
conversation provides the decision history; the existing `npm-release`
environment and `scripts/release-approval-receipt.mjs` remain the publication
approval record. Neither substitutes for the other. Reject/expired/changed
requests require a fresh explicit approval; changed contents require a new ID.

This is a deliberate **procedural trust boundary**. Shared human GitHub tokens
can technically be used by agents. A GitHub identity, environment approval or
receipt cannot prove an independent human acted. The release skills prohibit
agent self-approval; this design does not claim to technically prevent it.
Use the existing release-manager membership, not a new email allowlist or
domain-wide approval access.

## Prepare a request

```sh
pnpm release:publish-preflight approval request --request request.json
```

This local-only command validates the request and prints its canonical payload,
SHA-256 digest, pending-human-review instructions and `publicationAuthorized:
false`. It does not post a message, record a decision, contact a service, poll
status, dispatch a workflow or authorize validation skipping. Share the request
and digest in the normal release-managers group. Inspect decisions in that
conversation and publication approvals through the existing GitHub workflow.
There is no `approval approve`, `reject` or `status` command.

The contract in `scripts/lib/release-fast-track-contract.mts` binds repository,
release tag/channel, candidate commit, published reference release/commit and
validation-evidence digest, complete delta, policy, exact artifact digests,
publication scope, run/attempt, lowercase UUIDv4 request ID, expiry and explicit
action. Canonical serialization sorts artifacts and scope before hashing.
Persist the exact packet with release evidence; a digest alone is not approval.

## Publication policies

- `approved-fast-track-v1`: **at most 20 commits AND 15,000 total added/deleted
  lines** since a published, fully validated ancestor. Exclude only files named
  `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `bun.lock` or `bun.lockb` at any depth from LOC. All commits still
  count, including dependency-only commits. Count other generated files. Blob
  integrity checks still cover excluded files. Reject binary, submodule and otherwise unmeasurable
  changes or shallow history. A previous fast-track cannot reset the baseline.
  The Git-backed helper recomputes the delta; a typed reference assertion is not
  authenticated evidence.
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

## Publish an approved request

Keep `release_evidence_mode=full-release-validation`. Supply one additional
`fast_track_approval` JSON input to the existing publisher; the preflight helper
reads that JSON from a local file:

```sh
pnpm release:publish-preflight \
  --tag v2026.11.9 \
  --full-release-validation-run-id <original-frv-run-id> \
  --full-release-validation-run-attempt <original-frv-attempt> \
  --workflow-sha <trusted-publisher-sha> \
  --npm-dist-tag latest \
  --fast-track-approval approved-request.json
```

The normal preflight prints the dispatch command with the approval packet
included. Dispatch only within the separately granted publication authority.
Do not change the candidate, rebuild publication artifacts, or replace the
original FRV merely to fit the exception.

The packet contains:

- `request`: the existing immutable `FastTrackRequest` reviewed by the human.
- `digest`: `fastTrackRequestDigest(request)`, including its `sha256:` prefix.
- `approval`: `approver` (human identity), `decidedAt` (ISO timestamp) and `url`
  (the explicit decision permalink in the release-managers group).
- `referenceRunId` and `referenceRunAttempt`: required for
  `approved-fast-track-v1`, identifying the strictly successful validation of
  the published, fully validated reference. A previous fast-track is ineligible.
  The partial-FRV policy does not require these baseline-run fields.

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
results. Retain the approval packet separately with the release evidence;
postpublish, recovery and closeout must use that same publication binding.
Neither approved policy establishes a new fully validated baseline. Without a
packet, the ordinary strict validation requirements still apply.

### Expiry and replay

Approval must be explicit, unexpired and bound to unchanged contents when
publication starts. An already admitted publisher may finish after expiry;
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

## Public approval packets

Approval packets are public release evidence. Include only public-safe risk descriptions
and decision references. Never copy private release-managers messages, incident details,
credentials or access-bearing URLs into the request. Keep the private discussion in its
original group; disclose a conversation permalink only when the human authorizes making
that reference public. The packet does not copy or authenticate that conversation.

Context: [publisher integration #204520](https://github.com/openclaw/openclaw/pull/204520)
retains these packets in public Actions artifacts and publication receipts.
