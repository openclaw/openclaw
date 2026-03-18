# OpenClaw Contribution Roadmap

This roadmap turns the repository audit into a contribution path that is realistic, high-signal, and aligned with how OpenClaw is built today.

Related document:

- `docs/design/openclaw-repo-audit-contribution-plan.md`
- `docs/design/openclaw-system-inventory.md`
- `docs/design/openclaw-contribution-shortlist.md`
- `docs/design/openclaw-memory-diagnostics-pr-spec.md`

## Goal

Build enough system understanding to ship a contribution that is technically strong, easy to review, and visible to maintainers as real leverage rather than drive-by cleanup.

## Phase 1: Full System Discovery

Focus:

- understand OpenClaw as a product, not just a codebase
- map the main runtime surfaces: Gateway, agent runtime, channels, plugins, memory, ACP, cron, UI
- identify where the real control plane lives

Primary outputs:

- system overview
- user/persona understanding
- positioning vs LangGraph, AutoGen, and harness-only tools

## Phase 2: Architecture Breakdown

Focus:

- trace the main execution path from inbound message to final delivery
- identify the core subsystems and how they connect
- separate control plane logic from runtime logic

Primary outputs:

- high-level architecture summary
- component breakdown
- mermaid diagram
- request lifecycle walkthrough

## Phase 3: Core System Analysis

Focus:

- find the true ownership boundaries in the repo
- identify extensibility seams and complexity hotspots
- understand where contributors are likely to break things

Primary outputs:

- core module map
- key abstractions list
- complexity concentration analysis

## Phase 4: Product and Feature Mapping

Focus:

- translate architecture into product capabilities
- separate current features from implied future capabilities
- identify what is unique about OpenClaw

Primary outputs:

- capability map
- existing feature inventory
- missing but implied feature set

## Phase 5: Problem Identification

Focus:

- prioritize the highest-leverage problems
- favor problems that matter to maintainers, operators, and contributors
- avoid generic architecture critique

Primary outputs:

- top 5 problem list
- impact and rationale for each problem

## Phase 6: Opportunity Framing

Focus:

- separate quick wins from structural work
- identify missing primitives instead of only missing features
- frame gaps against current best practices in agent systems

Primary outputs:

- quick wins
- strategic improvements
- missing primitives
- gaps vs best practices

## Phase 7: Contribution Plan

Focus:

- propose contributions that look like real maintainer leverage
- prefer work that improves system clarity, reliability, or operator UX
- keep the first PR scoped enough to merge

Primary outputs:

- 1 to 3 proposal-level contributions
- recommended first PR
- modules impacted
- expected outcome and maintainer value

## Recommended Order

If the goal is both recognition and a realistic merge path, use this sequence:

1. Start with the audit doc in `docs/design/openclaw-repo-audit-contribution-plan.md`.
2. Pick the smallest contribution with real operator value.
3. Open a discussion first if the change crosses orchestration boundaries.
4. Ship one focused PR with tests and before/after reasoning.
5. Follow with a second PR that builds on the same subsystem.

## Best First Contribution

Best balance of visibility and mergeability:

- `Memory diagnostics and backend health`
- PR spec: `docs/design/openclaw-memory-diagnostics-pr-spec.md`

Highest upside contribution:

- `Agent run trace and explainability surface`

## Success Criteria

This roadmap is working if it leads to:

- one focused PR instead of a broad repo rewrite
- a change that touches a meaningful subsystem
- clear reasoning and diagrams in the PR
- maintainers seeing you as someone who can reduce complexity, not add to it
