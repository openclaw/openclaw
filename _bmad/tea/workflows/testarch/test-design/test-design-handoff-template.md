---
title: "TEA Test Design → BMAD Handoff Document"
version: "1.0"
workflowType: "testarch-test-design-handoff"
inputDocuments: []
sourceWorkflow: "testarch-test-design"
generatedBy: "TEA Master Test Architect"
generatedAt: "{timestamp}"
projectName: "{project_name}"
---

# TEA → BMAD Integration Handoff

## Purpose

This document bridges TEA's test design outputs with BMAD's epic/story decomposition workflow (`create-epics-and-stories`). It provides structured integration guidance so that quality requirements, risk assessments, and test strategies flow into implementation planning.

## TEA Artifacts Inventory

| Artifact             | Path                      | BMAD Integration Point                               |
| -------------------- | ------------------------- | ---------------------------------------------------- |
| Test Design Document | `{test_design_path}`      | Epic quality requirements, story acceptance criteria |
| Risk Assessment      | (embedded in test design) | Epic risk classification, story priority             |
| Coverage Strategy    | (embedded in test design) | Story test requirements                              |

## Epic-Level Integration Guidance

### Risk References

<!-- TEA will populate: P0/P1 risks that should appear as epic-level quality gates -->

### Quality Gates

<!-- TEA will populate: recommended quality gates per epic based on risk assessment -->

## Story-Level Integration Guidance

### P0/P1 Test Scenarios → Story Acceptance Criteria

<!-- TEA will populate: critical test scenarios that MUST be acceptance criteria -->

### Data-TestId Requirements

<!-- TEA will populate: recommended data-testid attributes for testability -->

## Risk-to-Story Mapping

| Risk ID | Category | P×I | Recommended Story/Epic | Test Level |
| ------- | -------- | --- | ---------------------- | ---------- |

<!-- TEA will populate from risk assessment -->

## Recommended BMAD → TEA Workflow Sequence

1. **TEA Test Design** (`TD`) → produces this handoff document
2. **BMAD Create Epics & Stories** → consumes this handoff, embeds quality requirements
3. **TEA ATDD** (`AT`) → generates acceptance tests per story
4. **BMAD Implementation** → developers implement with test-first guidance
5. **TEA Automate** (`TA`) → generates full test suite
6. **TEA Trace** (`TR`) → validates coverage completeness

## Phase Transition Quality Gates

| From Phase          | To Phase            | Gate Criteria                                          |
| ------------------- | ------------------- | ------------------------------------------------------ |
| Test Design         | Epic/Story Creation | All P0 risks have mitigation strategy                  |
| Epic/Story Creation | ATDD                | Stories have acceptance criteria from test design      |
| ATDD                | Implementation      | Failing acceptance tests exist for all P0/P1 scenarios |
| Implementation      | Test Automation     | All acceptance tests pass                              |
| Test Automation     | Release             | Trace matrix shows ≥80% coverage of P0/P1 requirements |
