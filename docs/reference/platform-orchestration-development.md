---
summary: "Local development wiring for the internal platform orchestration seam"
read_when:
  - Developing the internal Project to Promotion workflow
  - Refreshing the local platform contracts package
title: "Platform Orchestration Development"
---

# Platform orchestration development

The internal platform orchestrator coordinates one active project through Job, Execution, Review,
and Promotion. It stores revision-checked workflow state in the existing TaskFlow
`flow_runs.state_json` field. It does not add a gateway method, plugin surface, or SQLite schema.

Pi and Review are injected HTTP ports. Their adapters accept only bare `http://127.0.0.1:<port>` or
`http://[::1]:<port>` origins, send bearer authentication and idempotency keys, bound request and
response sizes, and redact service failures by not copying response bodies into errors or state.
Core validates project, job, execution, review, correlation, causation, commit, and artifact
associations before accepting a remote response or terminal event. A mismatch fails closed with a
fixed error code and is not persisted.

TaskFlow state is the restart authority. Before starting Pi, Review, or promotion, Core persists the
complete operation intent and deterministic idempotency key. Resume continues the same job from
`executing`, `awaiting_review`, `reviewing`, `approved`, or `promoting`: it reattaches to a persisted
accepted attempt, or safely replays the same start request when acceptance was not checkpointed.
It never creates a replacement job. The caller supplies the active project again so the private
repository path remains outside persisted state; Core verifies that its project, repository,
commit, and branch identity still match the checkpoint.

Promotion is private to Core. The adapter accepts only a bare Git repository, verifies that the
reviewed commit descends from the expected target, creates one squash commit with Git plumbing,
and atomically advances the local target ref. Commit metadata is deterministic, so replay after a
crash following `update-ref` returns the same prior promotion result. Git subprocesses receive an
explicit environment allowlist and cannot inherit ambient `GIT_*` overrides. Promotion never
pushes.

## Install the immutable contracts artifact

Core consumes the committed vendored source tree at
`vendor/openclaw-contracts/` (`@openclaw/contracts@0.1.0`). It is **not** an
npm dependency and does not modify lockfiles. Approved tree SHA-256:

```text
ae640f0d6e8b19cc8476e4231d502adfcc6a9c225b57b1b6c428f84d6eb586cc
```

Run:

```bash
pnpm verify:contracts
```

The relative vendor tree keeps workstation-specific absolute paths out of package metadata and
public DTOs. Runtime state contains only versioned IDs, commit identifiers, contract payloads, and
job transitions. Bearer tokens, repository paths, and service URLs are never persisted.

## Cross-repository acceptance evidence

The Core repository is independently consumable and its CI does not assume sibling Pi or Review
checkouts. Repository-local tests cover TaskFlow persistence, loopback HTTP adapters, semantic
identity checks, restart and replay behavior, and bare-repository squash promotion.

The full Core-to-Pi-to-Review roundtrip belongs to the platform acceptance workspace, where all four
independent repositories are explicitly provisioned. That harness uses ephemeral loopback ports and
temporary directories, actual Pi and Review HTTP servers, real SQLite stores, Pi worktrees and
artifacts, Review prechecks, and Core's `BareGitSquashPromotionAdapter`. It verifies completed
TaskFlow state, matching terminal identities, a two-commit promoted `main`, matching promoted and
execution trees, and absence of temporary paths, bearer tokens, and service URLs from persisted
state.

Do not add sibling-relative imports to Core tests. They pass only in one workstation layout and fail
in an independent clone or hosted CI.

## Final implementation status

The repository-local Core orchestration evidence is **PASS**: semantic identity
and correlation checks, persisted state-driven resume, deterministic promotion
replay, safe Git environment handling, and immutable Contracts consumption pass
16/16 focused tests. The external platform acceptance roundtrip also passes.

Core remains **Partial** until the hosted canonical repository gate and
owner-controlled dependency/security approvals complete. Focused proof does not
substitute for those gates.

The local bare-repository squash proof is test evidence only. The Core feature
branch is published for review, but upstream merge, release, and production
promotion are not complete.
