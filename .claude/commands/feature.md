Orchestrate a full 9-step quality-driven development cycle for: $ARGUMENTS

## Setup

1. Derive a kebab-case slug from the feature description (e.g., "add user auth" → `add-user-auth`)
2. Create feature branch: `git checkout -b feature/<slug>`
3. Create artifact directories: `docs/features/<slug>/adr/`, `docs/features/<slug>/quality/`, `docs/features/<slug>/planning/`

## Step 1: ADR (DDD)

Explore the codebase using Glob and Grep to understand existing architecture. Write an Architecture Decision Record to `docs/features/<slug>/adr/ADR-001-<slug>.md` following the project's ADR format: Status, Date, Bounded Context, Context, Decision, Consequences (Positive/Negative/Invariants/Domain Events), References. Commit: `docs: add ADR for <slug>`.

## Step 2: Shift-Left Testing

Invoke `/shift-left-testing` with the ADR path and output directory `docs/features/<slug>/quality/`. This validates requirements for testability, generates Gherkin acceptance tests, and produces a risk analysis. Commit: `quality: add shift-left testing report for <slug>`.

## Step 3: QCSD Ideation Swarm

Invoke `/qcsd-ideation` with the ADR path. This launches 3 parallel Task agents (Quality Criteria via HTSM, Risk Assessment via SFDIPOT, Testability Assessment) and synthesizes a gate decision. Output goes to `docs/features/<slug>/quality/`. If the gate decision is **NO-GO**, stop and report — the ADR needs revision. Commit: `quality: add QCSD ideation reports for <slug>`.

## Step 4: Code Goal Planner

Invoke `/code-goal-planner` with the ADR path and quality directory. This decomposes the feature into milestones with a dependency DAG, identifies files to create/modify, and finds parallelization opportunities. Output to `docs/features/<slug>/planning/`. Commit: `planning: add milestones for <slug>`.

## Step 5: Requirements Validation

Invoke `/requirements-validation` with all artifact paths. This cross-references every artifact for traceability and gap analysis. If the verdict is **NO**, loop back to the step indicated in the report (usually Step 1 or Step 2) and repeat from there. Commit: `quality: add requirements validation for <slug>`.

## Step 6: Implementation Swarm

Read `docs/features/<slug>/planning/milestones.md`. For each wave in the parallelization table, launch Task agents in parallel for milestones that have no unmet dependencies. Each agent implements one milestone following its acceptance criteria and test plan. After each wave completes, commit: `feat(<slug>): implement milestone N — <title>`. Run `pnpm check` after each wave to catch issues early.

## Step 7: Brutal Honesty Review

Invoke `/brutal-honesty-review` in `ramsay` mode targeting the feature branch changes. If the review finds **Critical** issues or grade is D/F, fix the issues and re-run the review (loop). Continue until grade is C or better with no Critical issues. Commit fixes: `fix(<slug>): address review findings`. Commit report: `quality: add brutal-honesty review for <slug>`.

## Step 8: Final Completeness Check

Read all 8 artifacts produced so far. Verify:

- All artifacts present in `docs/features/<slug>/`
- No unresolved Critical gaps from requirements validation
- No OPEN Critical issues from brutal-honesty review
- All milestones marked complete
- `pnpm check` passes

Write findings to `docs/features/<slug>/quality/final-gap-check.md`. If gaps found, loop back to the appropriate step (Step 1 for ADR gaps, Step 6 for implementation gaps, Step 7 for quality gaps). Commit: `quality: add final gap check for <slug>`.

## Step 9: QE Queen Assessment

Invoke `/qe-queen-assessment` with the feature directory. This produces the final quality score and verdict. Write to `docs/features/<slug>/quality/qe-queen-assessment.md`. Commit: `quality: add QE Queen assessment for <slug>`.

Report the final verdict to the user:

- **SHIP** — Feature is ready. Summarize the quality score and recommend creating a PR.
- **CONDITIONAL SHIP** — Feature is ready with conditions. List what remains.
- **NO-SHIP** — Feature needs more work. List blocking issues and which step to revisit.
