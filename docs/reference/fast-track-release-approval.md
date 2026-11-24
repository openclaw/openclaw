---
summary: "Release-manager review packets for proposed fast-track releases"
title: "Fast-track release approval"
read_when:
  - Preparing a fast-track release request for the release-managers group
  - Reviewing the proposed fast-track release policy
---

# Fast-track release approval

**Status: request preparation only. No publisher accepts a validation bypass.**
The existing parent, npm/plugin, Docker and closeout gates are unchanged. The
historical `authorized-beta-focused-v1` exception keeps its original contract.

## Approval model

Use the normal release-managers group and existing release approval process.
There is no separate Google Chat application, Firebase/Firestore database,
Cloud Run deployment, ID token, callback, custom decision store or status API.

**An agent must never approve a fast-track release, including through a token
that happens to belong to a release manager.** Before taking any fast-track
action, obtain explicit approval from **another human in the release-managers
group**, not the requester acting as their own approver. Generic release
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

## Policies retained for review

- `approved-fast-track-v1`: **at most 10 commits AND 10,000 total added/deleted
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
  validated release cannot reset the fully validated baseline. The small-delta
  eligibility helper rejects this policy pending authenticated evidence support.

Approval never waives package/build integrity, artifact identity, signing or
publication authorization. Future enforcement must retain original FRV evidence
and record **validation skipped by approved fast-track**, not fictional success.
Both policies remain preparation contracts, not enabled publisher modes.

## Remaining integration

Before enabling either policy, authenticate the reference/original FRV evidence,
seal exact artifacts, verify the approved request against independently derived
candidate/artifact/scope/run identities, and migrate the existing parent,
npm/plugin, Docker and closeout consumers together. Preserve normal release gates
and test both normal and exception paths. Do not introduce another approval
service or make a local packet an authorization receipt.

The former service source PR in `openclaw/releases` is superseded. Removing this
dependency does not delete any previously provisioned cloud resources, stored
records or setup credentials. Cloud decommissioning is a separate operational
cleanup; no current cloud-state or deletion claim is made here.

## Manual checks (not CI)

```sh
node scripts/run-vitest.mjs run --config test/manual-release-approval.config.ts
```

The suite stays outside normal CI discovery and refuses execution with `CI` set.
No test-budget allocation or new CI lane. Existing release tests are unchanged.
