# Project: FrankOS Governance System

## Project Summary
Define, implement, and operationalize a governance system for FrankOS so every agent can make traceable, safe, and consistent decisions across sessions and tools.

## Problem Statement
FrankOS has partial governance artifacts, but they are fragmented and not consistently loaded by agent boot flows. Phase 01 research and execution plans already exist, but project-level context and the end-to-end roadmap were missing, which blocked Phase 02 planning.

## Goals
1. Establish one canonical governance stack (mission, constitution, operator charter, working principles, memory constitution, agent identity).
2. Ensure governance is loaded at agent startup and applied during decision-making.
3. Add enforcement, validation, and audit mechanisms so governance is not documentation-only.
4. Make governance evolvable through explicit change control and measurable checks.

## Scope
### In Scope
- Governance doctrine and document architecture.
- Agent boot-time loading and governance discoverability.
- Runtime enforcement hooks and escalation rules.
- Validation scenarios for recall, hierarchy, and constitutional evaluation.
- Auditability via logs, checklists, and acceptance criteria.

### Out of Scope
- Broad product feature work unrelated to governance.
- Model training or fine-tuning changes.
- Non-governance refactors that do not affect compliance or decision quality.

## Constraints
- Build on existing Phase 01 artifacts in `.planning/phases/01-identity-governance-foundation/`.
- Preserve current operational workflows while introducing governance controls incrementally.
- Favor explicit, evaluable rules over aspirational language.
- Keep planning artifacts deterministic and machine-readable where practical.

## Success Criteria
1. All roadmap phases have explicit goals, dependencies, and completion criteria.
2. Agents can recall mission and decision hierarchy accurately from loaded governance sources.
3. Proposed actions can be evaluated as `PERMIT`, `PROHIBIT`, or `ESCALATE` with traceable reasoning.
4. Governance compliance can be tested and audited continuously.

## Current Baseline (2026-03-08)
- Phase 01 research completed.
- Two executable Phase 01 plans completed at planning level.
- Project and roadmap definitions were missing and are now being added here.
