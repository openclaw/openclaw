---
name: lfg
description: Full autonomous engineering workflow
argument-hint: "[feature description]"
disable-model-invocation: true
---

CRITICAL: You MUST execute every step below IN ORDER. Do NOT skip any required step. Do NOT jump ahead to coding or implementation. The plan phase (step 2, and step 3 when warranted) MUST be completed and verified BEFORE any work begins. Violating this order produces bad output.

1. **Optional:** If the `ralph-loop` skill is available, run `/ralph-loop:ralph-loop "finish all slash commands" --completion-promise "DONE"`. If not available or it fails, skip and continue to step 2 immediately.

2. `/ce:plan $ARGUMENTS`

   GATE: STOP. Verify that the `ce:plan` workflow produced a plan file in `docs/plans/`. If no plan file was created, run `/ce:plan $ARGUMENTS` again. Do NOT proceed to step 3 until a written plan exists.

3. **Conditionally** run `/compound-engineering:deepen-plan`

   Run the `deepen-plan` workflow only if the plan is `Standard` or `Deep`, touches a high-risk area (auth, security, payments, migrations, external APIs, significant rollout concerns), or still has obvious confidence gaps in decisions, sequencing, system-wide impact, risks, or verification.

   GATE: STOP. If you ran the `deepen-plan` workflow, confirm the plan was deepened or explicitly judged sufficiently grounded. If you skipped it, briefly note why and proceed to step 4.

4. `/ce:work`

   GATE: STOP. Verify that implementation work was performed - files were created or modified beyond the plan. Do NOT proceed to step 5 if no code changes were made.

5. `/ce:review`

6. `/compound-engineering:resolve-todo-parallel`

7. `/compound-engineering:test-browser`

8. `/compound-engineering:feature-video`

9. Output `<promise>DONE</promise>` when video is in PR

Start with step 2 now (or step 1 if ralph-loop is available). Remember: plan FIRST, then work. Never skip the plan.
