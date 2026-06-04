---
title: OpenClaw Ecosystem Control Plane Contract
summary: Machine-checkable governance contract for OpenClaw doctor-centered operational control plane workflows.
read_when:
  - You are implementing governed automation workflows in this repository.
  - You need contract, schema, validation, queue, artifact, and promotion-gate requirements.
---

# OpenClaw Ecosystem Control Plane Contract

Version: `v1.0.0`
Owner: `local_operator`
Status: `active`

## 1. Purpose

This contract defines the operational control plane for OpenClaw-backed agentic work, repository automation, curriculum generation, poster rendering, artifact promotion, and local/cloud LLM-assisted workflows.
The system must not rely on LLM confidence, chat memory, or prompt instructions as source of truth. Important work must be governed by machine-checkable contracts, schemas, validators, policies, artifacts, ledgers, queues, and human-review gates.

## 2. Core Principle

Ledgers record what happened.
Contracts define what should happen.
Policies define what is allowed.
Queues define what happens next.
Runners execute work.
Validators prove compliance.
Artifacts preserve evidence.
Dashboards expose state.
Review tools permit safe human intervention.
Promotion gates decide whether output can advance.

## 3. Required Ecosystem Components

Every governed workflow must declare usage state for each component below:

1. Contract
2. Schema
3. Validator
4. Queue
5. Runner
6. Scheduler
7. Orchestrator
8. Artifact store
9. Registry
10. Policy engine
11. Secret manager
12. Connector
13. Sandbox
14. Test suite
15. Observability layer
16. Dashboard
17. Review workbench
18. Diff tool
19. Cache
20. Cost monitor
21. Knowledge index
22. Ontology or taxonomy
23. Promotion gate
24. Fallback mode
25. Ledger
    If a component is not used, the workflow must declare one of:

- `not_required`
- `manual_only`
- `future_tranche`
- `blocked`
  Silent absence is prohibited.

## 4. System Components

### 4.1 Contracts

A contract is a written, machine-checkable rulebook.
Each contract must define:

- workflow name
- version
- owner
- allowed inputs
- required outputs
- required schema
- required validators
- allowed side effects
- forbidden side effects
- artifact requirements
- human review requirements
- promotion gates
- rollback or fallback behavior
  Prompts and LLM instructions are not contracts.
  Contracts are authoritative only when stored in-repo and registered in the contract registry.

### 4.2 Schemas

Schemas define exact data shapes and are required for:

- workflow run state
- queue items
- artifacts manifests
- validator outputs
- policy decisions
- curriculum maps and benchmark rows when those workflows are active
  Schema-governed status must be structured, not vague language.

### 4.3 Validators

Validators must return one of:

- `PASS`
- `WARN`
- `FAIL`
- `BLOCKED`
  Validators must not return ambiguous conclusions.
  Required validator classes include:
- schema validator
- contract validator
- PHI/secrets validator
- artifact validator
- coverage validator
- source citation validator
- dimension/resolution validator for image/PDF exports
- promotion-readiness validator

### 4.4 Queues

Required queue types:

- pending
- processing
- retry
- review
- dead_letter
  Queue items must carry deterministic status, attempt count, runner class, timestamps, and blocking reason.
  Retries must be bounded by contract-defined limits.

### 4.5 Runners

Allowed runner classes:

- local script
- Python/Node worker
- FastAPI worker
- GitHub Actions runner
- self-hosted runner
- container runner
- edge function
- manual operator
  Each runner must declare:
- permissions
- secret access
- side effects
- runtime limit
- retry behavior
- artifact destination
  Default posture:
- read-only first
- dry-run second
- write-capable only after validation
- production mutation only after explicit approval

### 4.6 Schedulers

Allowed schedule classes:

- manual
- on_demand
- hourly
- nightly
- on_merge
- on_file_change
- on_reviewer_approval
- incident_driven
  Schedulers must not silently perform production writes unless contract-allowed.

### 4.7 Orchestrators

Allowed orchestrators:

- Makefile
- npm/pnpm scripts
- Python task runner
- GitHub Actions
- Prefect, Airflow, Dagster, Temporal, Celery
- custom local orchestrator
  Orchestrated workflows must emit start, step, validation, artifact, and final events.
  Blocking validation failures stop workflow execution unless explicitly non-blocking by contract.

### 4.8 Artifact Store

Artifacts are evidence objects, not only outputs.
Each artifact must include a manifest with ID, workflow, hash, contract, schema, validator, and state.
Allowed states:

- `draft`
- `validated`
- `reviewed`
- `approved`
- `published`
- `archived`
  Artifacts must not contain PHI, secrets, raw tokens, or unredacted credentials.

### 4.9 Registries

Required registries:

- contracts
- schemas
- validators
- workflows
- tools
- connectors
- artifacts
- datasets/source registries where relevant
  Unregistered contracts/schemas/validators/workflows are not promotable.

### 4.10 Policy Engine

Policies must block:

- PHI storage
- secret leakage
- production mutation from pull requests unless explicitly allowed
- paid API calls in dry-run mode unless explicitly approved
- publication without validation
- force repair without reason/approval
- unbounded polling and unbounded retries
- silent degradation
- LLM-only approval
  Policy decision shape must include:
- `decision`: `allow|deny|review_required`
- `reason`
- `policy_id`

### 4.11 Secret Managers

Secrets must never be stored in repository files, logs, screenshots, prompts, artifacts, or exports.
Allowed stores include GitHub Secrets, keychain, Vault-class systems, or scoped environment variables.
Validation may confirm presence/validity but never print raw values.

### 4.12 Connectors

Connectors must declare capability class:

- `read_only`
- `draft_only`
- `write_capable`
- `send_capable`
- `admin`
- `clinical`
- `non_clinical`
  Default connector posture:
- read-only first
- draft-only second
- write after explicit approval
- admin only manual

### 4.13 Sandboxes

Required modes:

- dry_run
- staging
- production
  Dry-run must answer projected creates/modifies/deletes/sends/costs/exposures/artifacts and must not mutate production.

### 4.14 Test Suites

Where applicable, test coverage includes:

- unit
- integration
- contract
- schema
- regression
- snapshot/golden
- security
- performance
  Tests validate code behavior; validators validate output compliance. Promotion can require both.

### 4.15 Observability

Required signals:

- logs
- metrics
- health
- run duration
- queue depth
- failure and retry counts
- validation failures
- suppressed emits
- cost estimates
- artifact counts
- freshness timestamps

### 4.16 Dashboards

Dashboards must answer:

- What needs attention?
- What is blocked?
- What is safe to promote?
- What changed?
- What proof exists?
- What is repeatedly failing?

### 4.17 Review Workbenches

Required review actions:

- approve
- reject
- request_revision
- defer
- promote
- archive
- force_with_reason
  Reviewed objects must distinguish generated, validated, reviewed, approved, and promoted states.

### 4.18 Diff Tools

Required diff classes where applicable:

- text
- JSON
- schema
- HTML visual
- PDF image
- screenshot
- migration diff
- semantic content diff

### 4.19 Caches

Caches must define key, source hash, expiration, invalidation rule, and rebuild command.
Stale cache is not current evidence.

### 4.20 Cost Monitors

Paid-resource workflows must emit cost summaries with token, API call, and estimated cost metrics.
Unattended automation requires budget ceilings.

### 4.21 Knowledge Indexes

Knowledge indexes must preserve source path/hash, section mapping, evidence strength, timestamp, and allowed-use class.

### 4.22 Ontologies and Taxonomies

Domain taxonomy records must support reusable structured mapping across educational and QA surfaces.

### 4.23 Promotion Gates

Allowed lifecycle states:

- `draft`
- `generated`
- `validated`
- `reviewed`
- `approved`
- `published`
- `archived`
  Promotion requires:
- registered contract
- required schema
- validator pass
- policy allow
- artifact manifest
- no unresolved blocking findings
- human review when required
  Workflows must not skip from `generated` to `published`.

### 4.24 Fallback Modes

High-risk workflows must define safe fallback behavior and must not hide failures while degrading.

### 4.25 Ledgers

Every governed operation appends immutable operational records with event, status, timestamps, and artifact references.

## 5. OpenClaw Doctor Integration

`openclaw doctor` is one verification tool inside the control plane.
Required lanes:

- Read-only health lane:
  - `pnpm openclaw doctor --lint --json --severity-min warning`
- Post-upgrade lane:
  - `pnpm openclaw doctor --post-upgrade --json`
- Deep scan lane:
  - `pnpm openclaw doctor --lint --deep --json`
- Safe repair lane:
  - `pnpm openclaw doctor --repair --non-interactive --yes`
- Force repair lane (manual only):
  - `pnpm openclaw doctor --repair --force`
- Secret verification lane (manual only unless approved):
  - `pnpm openclaw doctor --lint --allow-exec --json`
    Force repair requires pre- and post-repair artifacts plus human approval.

## 6. Required Repository Structure

Control-plane assets for this repository are expected under:

- `docs/contracts/`
- `registries/`
- `schemas/`
- `scripts/openclaw-*.sh`
- `scripts/validate_openclaw_control_plane.cjs`
- `scripts/append_operational_ledger.cjs`
- `queues/`
- `reports/`
- `ledgers/`
- `artifacts/`
- `dashboards/`

## 7. PHI and Secret Safety

If PHI is detected:

- status: `BLOCKED`
- action: quarantine locally
- promotion: prohibited
- human review: required
  If secret leakage is detected:
- status: `BLOCKED`
- action: redact and rotate where needed
- promotion: prohibited
- human review: required

## 8. Promotion Rule

Promotion is allowed only when all are true:

1. Contract exists and is registered.
2. Required schema exists.
3. Validator exists and passes.
4. Policy allows the action.
5. Artifact manifest exists.
6. Ledger entry exists.
7. Diff exists where prior version exists.
8. Human review exists when required.
9. No PHI or secret violations.
10. No unresolved blocking findings.

## 9. Anti-Patterns

Prohibited:

- LLM confidence as proof
- unbounded polling/retries
- silent retries/degradation
- force repair without reason
- overwriting approved artifacts
- secrets/PHI in repo artifacts or logs
- unregistered contracts promoted
- generated content published without validation

## 10. Minimal Operating Model

Minimum acceptable control plane:

1. Contracts
2. Schemas
3. Validators
4. Queues
5. State store
6. Event/audit/decision ledgers
7. Artifact store
8. Test suite
9. Dashboard
10. Review workbench
11. Policy engine
12. Knowledge index
    Operational loop:
    Define rules -> Route work -> Execute -> Validate -> Record decision -> Store proof -> Display state -> Review risk -> Promote when safe.
