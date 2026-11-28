---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use with `$release-openclaw-maintainer` and `$openclaw-testing` for candidate validation, install/update proof, live-provider checks, and CI recovery.

Read [guardrails](references/guardrails.md) in full before executing this workflow.
They own approval, frozen C/Q/P identities, source isolation, credentials, and
receipt/attempt rules. Then read the guide for the current phase:

| Task                                                              | Guide                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Select validation, reuse nightly proof, or repair release tooling | [Readiness](references/readiness.md), then [recovery](references/recovery.md) for a failed run |
| Preflight or dispatch a frozen candidate                          | [Dispatch](references/dispatch.md)                                                             |
| Watch a run or diagnose a failure                                 | [Watch and triage](references/watch-and-triage.md)                                             |
| Retry, continue, or recover retained evidence                     | [Recovery](references/recovery.md)                                                             |
| Publish or recover publication                                    | [Publication](references/publication.md)                                                       |
| Validate extended-stable                                          | [Extended-stable](references/extended-stable.md), plus dispatch and guardrails                 |

Read each selected guide in full. Validation never grants publication approval.
Keep one operator and watcher, preserve frozen inputs and receipts, and diagnose
the failing boundary before retrying.

## Evidence

Record:

- Lifecycle: regular Code/Release SHA; extended-stable canonical branch/exact SHA/immutable tag. Both: C/Q/P, original admission descriptor, retained request.
- Reuse policy, coverage policy, complete changed paths.
- Active full-parent URL/attempt/workflow SHA; superseded parents/exact replacement reasons.
- Selected child IDs/conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance. Deferred confidence = not run.
- Terminal-manifest core/plugin npm publication artifact descriptors.
- All selected lane conclusions, including Linux/Windows/macOS cross-OS.
- Performance comparisons with earlier releases when available; targeted local proof commands.
- Frozen-target compatibility repairs/omitted inapplicable scenarios, source PRs/invariant.
- Hosted proof/deployment prerequisites separately from local contracts: mocks cannot prove Actions admission, OIDC, environment access, publication.
- Known gaps/unrelated failures.

Lessons/recovery patterns: `references/release-ci-notes.md`.

For public-safe approval evidence, follow [public request packets](../release-openclaw-maintainer/references/fast-track.md#public-request-packets).

## Fast-track approval boundary

Read [Fast-track approval boundary](references/publication.md#fast-track-approval-boundary).

## Guardrails

Read [Guardrails](references/guardrails.md#guardrails).

### Scope and authority

Read [Scope and authority](references/guardrails.md#scope-and-authority).

### Frozen identities and qualification

Read [Frozen identities and qualification](references/guardrails.md#frozen-identities-and-qualification).

### Runtime, capacity, and independent publication

Read [Runtime, capacity, and independent publication](references/guardrails.md#runtime-capacity-and-independent-publication).

### Credentials and observation

Read [Credentials and observation](references/guardrails.md#credentials-and-observation).

### Plans, attempts, and recovery

Read [Plans, attempts, and recovery](references/guardrails.md#plans-attempts-and-recovery).

### Isolated checkouts and Testbox

Read [Isolated checkouts and Testbox](references/guardrails.md#isolated-checkouts-and-testbox).

## Receipt-backed aggregate recovery

Read [Receipt-backed aggregate recovery](references/recovery.md#receipt-backed-aggregate-recovery).

## Repair release tooling without changing the product (C ≠ Q)

Read [Repair release tooling without changing the product (C ≠ Q)](references/recovery.md#repair-release-tooling-without-changing-the-product-c--q).

## Keep FRV off the idle path

Read [Keep FRV off the idle path](references/readiness.md#keep-frv-off-the-idle-path).

### Optional broad CI discovery alongside initial FRV

Read [Optional broad CI discovery alongside initial FRV](references/readiness.md#optional-broad-ci-discovery-alongside-initial-frv).

## Deferred CI recovery

Read [Deferred CI recovery](references/readiness.md#deferred-ci-recovery).

## Continuous release readiness

Read [Continuous release readiness](references/readiness.md#continuous-release-readiness).

## Release tooling fast lane

Read [Release tooling fast lane](references/readiness.md#release-tooling-fast-lane).

## Run identity and retry budget

Read [Run identity and retry budget](references/recovery.md#run-identity-and-retry-budget).

### Parent ownership and cancellation

Read [Parent ownership and cancellation](references/recovery.md#parent-ownership-and-cancellation).

### Diagnose before retrying

Read [Diagnose before retrying](references/recovery.md#diagnose-before-retrying).

### Controller recovery

Read [Controller recovery](references/recovery.md#controller-recovery).

## Preflight

Read [Preflight](references/dispatch.md#preflight).

### Before publication

Read [Before publication](references/publication.md#before-publication).

## Dispatch

Read [Dispatch](references/dispatch.md#dispatch).

### Child receipts and reuse

Read [Child receipts and reuse](references/dispatch.md#child-receipts-and-reuse).

### Optional beta performance

Read [Optional beta performance](references/dispatch.md#optional-beta-performance).

### Admit and dispatch the exact tuple

Read [Admit and dispatch the exact tuple](references/dispatch.md#admit-and-dispatch-the-exact-tuple).

### Request reconciliation

Read [Request reconciliation](references/dispatch.md#request-reconciliation).

### Routes and frozen context

Read [Routes and frozen context](references/dispatch.md#routes-and-frozen-context).

### Release notes and publication bytes

Read [Release notes and publication bytes](references/publication.md#release-notes-and-publication-bytes).

### Publication requirements

Read [Publication requirements](references/publication.md#publication-requirements).

### Publish children

Read [Publish children](references/publication.md#publish-children).

#### Approval receipts

Read [Approval receipts](references/publication.md#approval-receipts).

#### ClawHub recovery

Read [ClawHub recovery](references/publication.md#clawhub-recovery).

#### Stale children

Read [Stale children](references/publication.md#stale-children).

### Extended-stable validation

Read [Extended-stable validation](references/extended-stable.md#extended-stable-validation).

### Frozen-target test omissions

Read [Frozen-target test omissions](references/extended-stable.md#frozen-target-test-omissions).

## Watch

Read [Watch](references/watch-and-triage.md#watch).

## Failure Triage

Read [Failure Triage](references/watch-and-triage.md#failure-triage).
