# FrankOS Governance Roadmap

## Roadmap State
- Date: 2026-03-08
- Project file: `.planning/PROJECT.md`
- Current planning baseline: Phase 01 researched and planned

## Phase Overview

## Phase 01: Identity & Governance Foundation
- ID: `01`
- Slug: `01-identity-governance-foundation`
- Status: `planned-ready`
- Goal: Define the canonical governance stack and produce executable plans for governance document creation, integration, and verification.
- Dependencies: none
- Existing artifacts:
  - `.planning/phases/01-identity-governance-foundation/01-RESEARCH.md`
  - `.planning/phases/01-identity-governance-foundation/01-01-PLAN.md`
  - `.planning/phases/01-identity-governance-foundation/01-02-PLAN.md`
- Exit criteria:
  - Governance stack specification is complete.
  - Execution plans cover document buildout and boot integration.

## Phase 02: Runtime Governance Enforcement
- ID: `02`
- Slug: `02-runtime-governance-enforcement`
- Status: `planned-ready`
- Goal: Implement enforceable runtime controls so agents consistently apply constitutional rules during task execution, escalation, and memory operations.
- Dependencies:
  - Phase 01 complete
- Existing artifacts:
  - `.planning/phases/02-runtime-governance-enforcement/02-RESEARCH.md`
  - `.planning/phases/02-runtime-governance-enforcement/02-01-PLAN.md`
  - `.planning/phases/02-runtime-governance-enforcement/02-02-PLAN.md`
- Planned deliverables:
  - Governance enforcement design (decision checkpoints + escalation gates).
  - Runtime integration plan for mission/constitution checks in agent workflows.
  - Compliance telemetry plan (events/logging for permit/prohibit/escalate outcomes).
- Exit criteria:
  - Runtime enforcement path is defined end-to-end.
  - Clear implementation tasks exist for code/docs changes.
  - Validation scenarios are specified for failure and edge cases.

## Phase 03: Memory Integrity & Traceability
- ID: `03`
- Slug: `03-memory-integrity-traceability`
- Status: `not-planned`
- Goal: Enforce truthfulness, provenance, and correction workflows for memory so evidence and inference are never conflated.
- Dependencies:
  - Phase 02 complete
- Planned deliverables:
  - Memory write/read policy enforcement plan.
  - Provenance and supersession metadata standards.
  - Audit workflow for memory corrections and uncertainty tagging.
- Exit criteria:
  - Memory governance is testable and traceable.
  - Unsafe memory mutations are blocked or escalated by design.

## Phase 04: Validation, Rollout, and Operations
- ID: `04`
- Slug: `04-validation-rollout-operations`
- Status: `not-planned`
- Goal: Operationalize governance with repeatable tests, rollout controls, monitoring, and continuous review.
- Dependencies:
  - Phase 03 complete
- Planned deliverables:
  - Governance test suite and acceptance checklist.
  - Rollout plan with rollback and incident handling.
  - Ongoing governance review cadence and ownership model.
- Exit criteria:
  - Governance checks are part of normal delivery workflow.
  - Review and amendment process is active and measurable.

## Planning Rules
- New phase plans must reference phase ID and slug exactly as defined here.
- Any roadmap change must update dependencies and exit criteria.
- Phase status values: `not-planned`, `planned-ready`, `in-progress`, `completed`, `blocked`.
