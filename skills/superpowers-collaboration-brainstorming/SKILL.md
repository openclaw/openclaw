---
name: superpowers-collaboration-brainstorming
description: Refine a rough feature or project idea into a concrete design before implementation. Use when a user is exploring an idea, asking for approaches, or needs requirements clarified before code or a detailed plan.
---

# Brainstorming

Turn a vague idea into a design that is specific enough to implement.

This skill is for design clarification, not coding. Use it before writing code, before drafting a detailed implementation plan, and whenever a request is still ambiguous enough that different architectures would lead to materially different work.

## Goals

- Understand the real problem, not just the first proposed solution.
- Expose constraints, success criteria, and likely failure modes early.
- Explore multiple viable approaches before converging.
- Produce a concrete design handoff or transition cleanly into the planning skill.

## Working Rules

- Ask one focused question at a time while requirements are still unclear.
- Prefer constrained choices when useful, but do not force fake certainty.
- Do not jump into implementation while key product or technical constraints are unresolved.
- Check the local codebase before proposing changes to existing systems.
- If the user already asked for implementation and the design is obvious, skip this skill and build.

## Phase 1: Understand The Problem

Start by grounding yourself in the codebase and the user's goal.

1. Inspect the relevant local area first.
2. Identify:
   - the user-visible goal
   - constraints or non-goals
   - what already exists
   - what is still ambiguous
3. Ask the single highest-leverage question.

Good questions narrow the space:

- "Is this meant to be user-facing behavior or internal tooling?"
- "Should this extend the existing onboarding flow or be separate?"
- "Is backwards compatibility required for existing plugins?"

Bad questions ask for information you can discover yourself from the repo.

## Phase 2: Explore Alternatives

Once the problem is clear enough, present 2-3 real approaches.

For each approach, include:

- the core idea
- where it fits in the current codebase
- main tradeoffs
- implementation complexity
- likely testing strategy

Good exploration compares approaches honestly. Do not present one real option plus two strawmen.

## Phase 3: Converge On A Design

After the user reacts, write down the chosen direction in compact sections. Keep each section short enough to validate quickly.

Cover the parts that matter:

- architecture
- key files or modules
- data flow or control flow
- error handling or edge cases
- testing approach

After each meaningful section, pause for confirmation if uncertainty remains. If the user introduces a new constraint, go backward instead of forcing the current plan forward.

## Phase 4: Handoff

When the design is stable, choose the next step explicitly:

- If implementation should start now, proceed with normal coding work.
- If a detailed execution plan is needed, switch to `skills/superpowers-collaboration-writing-plans/SKILL.md`.

For design docs in this repo, prefer:

- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` for design notes
- `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` for execution plans

## Output Shape

When you finish brainstorming, leave the user with:

1. A one-paragraph problem statement.
2. The chosen approach and why it won.
3. A short implementation outline.
4. Open questions, if any remain.

## Guardrails

- Do not invent constraints when the repo can answer them.
- Do not overdesign a simple change.
- Do not ask multiple stacked questions in one turn unless they are tightly coupled.
- Do not claim a design is final if the testing strategy or integration point is still unknown.

## Related Skills

- `skills/superpowers-collaboration-writing-plans/SKILL.md` for turning an approved design into execution steps.
- `skills/superpowers-debugging-systematic-debugging/SKILL.md` when the request is really a bug investigation, not design work.
- `skills/superpowers-testing-test-driven-development/SKILL.md` when moving from design into implementation.
