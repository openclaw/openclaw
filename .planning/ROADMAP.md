# FrankOS Governance Roadmap

## Roadmap State
- Date: 2026-03-08
- Project file: `.planning/PROJECT.md`
- Current planning baseline: Phase 02, Phase 03, and Phase 04 completed; Phase 06 completed

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
- Status: `completed`
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
  - Human verification gate passed for shadow and enforce behavior.

## Phase 03: Memory Integrity & Traceability
- ID: `03`
- Slug: `03-memory-integrity-traceability`
- Status: `completed`
- Goal: Enforce truthfulness, provenance, and correction workflows for memory so evidence and inference are never conflated.
- Dependencies:
  - Phase 02 complete
- Planned deliverables:
  - `.planning/phases/03-memory-integrity-traceability/03-RESEARCH.md`
  - `.planning/phases/03-memory-integrity-traceability/03-01-PLAN.md`
  - `.planning/phases/03-memory-integrity-traceability/03-02-PLAN.md`
  - Memory write/read policy enforcement plan.
  - Provenance and supersession metadata standards.
  - Audit workflow for memory corrections and uncertainty tagging.
- Exit criteria:
  - Memory governance is testable and traceable.
  - Unsafe memory mutations are blocked or escalated by design.

## Phase 04: Validation, Rollout, and Operations
- ID: `04`
- Slug: `04-validation-rollout-operations`
- Status: `completed`
- Goal: Operationalize governance with repeatable tests, rollout controls, monitoring, and continuous review.
- Dependencies:
  - Phase 03 complete
- Existing artifacts:
  - `.planning/phases/04-validation-rollout-operations/04-RESEARCH.md`
  - `.planning/phases/04-validation-rollout-operations/04-01-PLAN.md`
  - `.planning/phases/04-validation-rollout-operations/04-02-PLAN.md`
- Planned deliverables:
  - Governance test suite and acceptance checklist.
  - Rollout plan with rollback and incident handling.
  - Ongoing governance review cadence and ownership model.
- Exit criteria:
  - Governance checks are part of normal delivery workflow.
  - Review and amendment process is active and measurable.

## Phase 06: Memory, Continuity, and Contradiction Testing
- ID: `06`
- Slug: `06-memory-continuity-contradiction-testing`
- Status: `completed`
- Goal: Define and execute suites that validate memory integrity, mode continuity, and contradiction handling paths.
- Dependencies:
  - Phase 04 complete
- Existing artifacts:
  - `.planning/phases/06-memory-continuity-contradiction-testing/06-01-SUITES.md`
  - `.planning/phases/06-memory-continuity-contradiction-testing/06-02-EVIDENCE.md`
  - `.planning/phases/06-memory-continuity-contradiction-testing/06-02-SUMMARY.md`
- Exit criteria:
  - L031-L033 suite definitions are documented with pass criteria.
  - L034-L036 suite executions pass and are evidence-backed.

## Phase 07: Role Governance and Interaction Mapping
- ID: `07`
- Slug: `07-role-governance-operations`
- Status: `in-progress`
- Goal: Freeze operator baseline, finalize role definitions, and formalize interaction/escalation flows.
- Dependencies:
  - Phase 06 complete
- Existing artifacts:
  - `.planning/phases/07-role-governance-operations/07-01-BASELINE-FREEZE.md`
  - `.planning/phases/07-role-governance-operations/07-02-ROLE-INTERACTION-MAP.md`
- Exit criteria:
  - L037 baseline freeze documented and approved.
  - L038-L043 role definitions finalized.
  - L044 interaction map completed with escalation paths and decision rights.

## Planning Rules
- New phase plans must reference phase ID and slug exactly as defined here.
- Any roadmap change must update dependencies and exit criteria.
- Phase status values: `not-planned`, `planned-ready`, `in-progress`, `completed`, `blocked`.
