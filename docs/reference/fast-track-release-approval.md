---
summary: "Google Chat human approval requests and the boundaries still required for fast-track releases"
title: "Fast-track release approval"
read_when:
  - Requesting or inspecting Google Chat approval for a fast-track release
  - Reviewing the proposed fast-track release policy
---

# Fast-track release approval

**Implementation status: approval service and request/status tooling only.**
This does not enable validation skipping in any publisher. The npm, Docker and
release-closeout paths still require their existing evidence. Do not substitute
an approval receipt for Full Release Validation or the historical
`authorized-beta-focused-v1` exception.

## Request and inspect

Approval request/status operations use the existing publication-preflight command,
not a separate release CLI. The normal preflight report and dispatch contract
remain unchanged; approval operations do not run or bypass those gates.

Use a Google-issued ID token for the independently managed approval service.
Request-only identities can create/read requests; read-only identities can read
results. Neither can approve. Keep tokens in the environment or a managed secret
channel, not arguments, request files, logs or commits.

```sh
pnpm release:publish-preflight approval request --request request.json
pnpm release:publish-preflight approval status --request request.json
```

The operator configures `FAST_TRACK_APPROVAL_SERVICE_ORIGIN` to a fixed HTTPS
origin and supplies `FAST_TRACK_APPROVAL_ID_TOKEN` for that audience. Do not take
the origin from candidate code or from the approval request. Retry the identical
request after uncertain delivery; any changed contents require a new request ID
and new human approval. Status output explicitly reports
`publicationAuthorized: false`: inspecting approval does not authorize publishing.

The immutable JSON contract in `scripts/lib/release-fast-track-contract.mts`
identifies repository, release tag/channel, candidate commit, published reference
release/commit and validation-evidence digest, commit/line delta, threshold policy,
artifact SHA-256 digests, publication scope, run/attempt, lowercase UUIDv4 request
identity, expiry, and the action **Approve skipping release validation**. Canonical
serialization sorts artifact and scope sets before hashing exact UTF-8 bytes.
The service accepts payloads up to 12,000 bytes and rejects cards exceeding
Google Chat's rendered-message limit.

## Proposed eligibility policy

`approved-fast-track-v1` allows **at most 10 commits AND at most 50,000 total
added/deleted lines** since a **published, fully validated ancestor**. These inclusive limits were selected for this proposal; approval does not replace
package integrity or publication authorization. A previous
fast-track release cannot reset the reference. Include generated files. Binary,
submodule or otherwise unmeasurable changes are ineligible. Shallow history is
insufficient. The Git-backed helper recomputes counts and rejects caller/count or
reference mismatches; its typed reference input is not itself authentication.

## Partial-FRV approval policy

`approved-partial-frv-v1` uses the same service and approvers, but a different
explicit action: **Approve publication with incomplete validation**. It has no
commit/line ceiling. It does not widen `approved-fast-track-v1` or turn a failed
FRV run into a successful one.

The request includes an operator reason and `validationSnapshot`: exact FRV
run/attempt and candidate SHA, capture time, a durable GitHub evidence URL and
SHA-256 digest, passed/failed/cancelled/skipped/unfinished counts, and every
outstanding check's name, category, job ID and producing run/attempt. At least
one check must have passed, and every non-passing count must match the enumerated
checks. The retained snapshot must preserve original job statuses/conclusions,
not just this card's summary. The reason is an operator statement, not verified
evidence. A changed snapshot, reason or artifact requires a new approval.

This is currently a **request/status contract only**. The existing small-delta
verifier explicitly refuses this policy; it cannot be used to evade its limits.
Publisher support must authenticate and retain the snapshot using the existing
FRV evidence owners, verify exact source/artifact/publication bindings, and keep
build/package integrity and publication authorization mandatory. Neither a URL,
caller-supplied summary nor a matching hash establishes that authentication.
Keep original FRV results and the separate human exception in release evidence.
A partially validated release never resets the fully validated baseline.

## Readable approval cards

Cards show labeled release details, change counts, and a compact validation
summary. Outstanding checks are visible before expanding technical details.
Source/reference information, exact artifact digests, request identity and policy
remain available in expandable sections. Evidence URLs are clickable HTTPS links;
unknown fields are also displayed. JSON is retained for exact hashing/storage,
not dumped into the human review card. Decision buttons keep the same immutable
request/digest binding and disappear after the first decision.

## Manual checks (not CI)

Approval-client checks are deliberately outside the standard `*.test.ts` CI
inventory. Run them explicitly before changing these operator tools:

```sh
node scripts/run-vitest.mjs run --config test/manual-release-approval.config.ts
```

The manual configuration refuses execution when `CI` is set. No test-budget
allocation is required for this manual suite. Existing unrelated release tests
remain in their normal CI lanes. Backend/callback tests belong with the separately
owned approval service, not this repository. Client tests do not import its
implementation or require access to its source.

## Independent human decision

Service deployment and backend implementation are owned separately and are not
shipped from this repository. This repository owns only the approval client and
release-request/verification contracts.
Only authenticated Google Chat Workspace add-on button events from the exact
Vincent/Dallin allowlist can settle requests. Email enrollment is pinned to stable
Google user IDs in private DMs. The managing account is not an approver. App
visibility and the backend allowlist are both restricted, not domain-wide.

The first decision wins transactionally. Repeated or conflicting clicks explicitly
report that the existing decision was unchanged. The original card becomes a
status-only card with no buttons. Bounded attempt metadata distinguishes the
received decision, previous state and recorded/unchanged outcome without storing
callback bodies. A rejection cannot be converted into approval by a retry.

Google-signed callback authentication is distinct from caller authentication.
Caller-supplied identities, display names, message text, GitHub actors/reviews and
GitHub environment approvals are not independent human approval evidence.

## Remaining publisher cutover and acceptance gates

This feature must not be enabled until one cohesive evidence path:

1. Authenticates the published fully validated reference using the existing strict
   release-evidence owner, rather than trusting a caller's JSON assertion.
2. Builds/packages and seals exact artifacts without representing skipped tests
   as successful validation, then binds all digests and publication operands to
   the human request.
3. Recomputes eligibility and verifies the live, unexpired approval at each
   enforcing publisher using independently derived source, artifact, scope and
   run identities. Record **validation skipped by approved fast-track**, never a
   fabricated successful validation run.
4. Migrates the parent, npm/plugin, Docker, diagnostics and closeout consumers
   together while preserving normal gates and the historical focused exception.
5. Has exact-head normal/fast-track integration proof, fresh independent review,
   deliberate human mobile Approve/Reject proof and visible-card evidence.
6. Verifies publisher/tag/registry bypass authority and Google impersonation or
   Workspace domain-wide delegation. Deployment, allowlist, database writes and
   enforcement changes must remain outside release-agent access. Temporary setup
   credentials and equivalent vault/admin access must be revoked or explicitly
   reported as unresolved.

The existing verifier helper checks exact request/response binding, expiry and
allowlisted stable approver identity, then recomputes Git eligibility. It is a
building block, not an independently authenticated reference selector or a wired
publication gate. No workflow consumes its result yet.
