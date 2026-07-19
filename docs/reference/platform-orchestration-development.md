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

The root dependency uses the committed repository-relative package reference:

```text
file:vendor/packages/openclaw-contracts-0.1.0.tgz
```

Its approved SHA-256 is
`5863c0b19a6ecb3c552392bac2074dd72ee67a5a8dc0061760a1b0257c62465a`.
The lifecycle verifier and lockfile integrity bind these exact bytes. No sibling
checkout, workspace link, symlink, or absolute path is required. Run:

```bash
corepack pnpm install --frozen-lockfile
```

The relative reference keeps workstation-specific absolute paths out of package metadata and
public DTOs. Runtime state contains only versioned IDs, commit identifiers, contract payloads, and
job transitions. Bearer tokens, repository paths, and service URLs are never persisted.

## Verify the local service roundtrip

Keep Core, Contracts, Pi Service, and Review Service as sibling repositories with their existing
dependencies installed. From the Core repository, run:

```powershell
node scripts/run-vitest.mjs src/platform-orchestration/local-platform-roundtrip.integration.test.ts
```

The focused integration test uses ephemeral loopback ports and temporary directories. It starts the
actual Pi and Review HTTP servers in-process, then drives them through Core's
`LoopbackPiExecutionAdapter` and `LoopbackReviewAdapter`. Pi uses its real SQLite store, worker,
Git worktree manager, artifact store, and a deterministic registered skill. Review uses its real
SQLite store, processor, prechecks, event stream, and HTTP server with `FakeCursorReviewAdapter`.
The approved Pi commit is finally squash-promoted into a temporary bare repository by Core's
`BareGitSquashPromotionAdapter`.

On Windows with Node `v24.17.0`, the focused command passed one test on July 18, 2026. The initial
cross-service verification used these direct commands:

```powershell
# Core: 5 files, 9 tests passed
node scripts/run-vitest.mjs src/platform-orchestration

# Pi Service: canonical checks passed, 32 tests passed
corepack pnpm check

# Review Service: canonical checks passed, 31 tests passed
corepack pnpm check

# Contracts: generation check, 58 tests, and 22 packed files passed
corepack pnpm check
```

The roundtrip verifies completed TaskFlow state, Pi and Review terminal events, a two-commit
promoted `main`, matching promoted and execution trees, and absence of temporary paths, bearer
tokens, and service URLs from persisted orchestration state. Cleanup closes both HTTP servers,
waits for Pi's worker, removes the linked Git worktree and prunes its metadata, closes both SQLite
stores, resets TaskFlow state, and then removes temporary files.

This is local deterministic boundary verification, not hosted Cursor verification. It neither reads
nor requires `CURSOR_API_KEY`, and it does not exercise `HostedCursorReviewAdapter`, remote agents,
deployment, push, or production service processes.

## Final implementation status

The focused Core orchestration evidence is **PASS**: semantic identity and
correlation checks, persisted state-driven resume, deterministic promotion
replay, safe Git environment handling, and immutable Contracts consumption pass
17/17 focused tests. The local Core to Pi to Review roundtrip also passes.

Core remains **Partial** because the full canonical repository gate has not
been completed after the final implementation batch. The locked dependency
installation completed successfully, but focused proof does not substitute for
that full gate.

Production service deployment and Git promotion are **Not Deployed / Not
Performed**. The local bare-repository squash proof is test evidence only:
Core has not promoted a real project ref, committed E12 documentation, pushed,
released, or deployed anything.

The official platform score remains `1,160 / 1,300` (**89.2%**) and E11 is
**APPROVED_WITH_NOT_DEPLOYED_GAPS** with all HIGH findings closed. Architecture
found no remaining boundary, contract, or workflow blocker at 2026-07-18 21:50
+03; Design Phase is complete and Implementation Phase is active.
