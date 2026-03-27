# Protocol Awareness

## Category
Skill Orchestration

## Relevant Roles
Orchestrators, Lead agents, any agent operating within a multi-skill ecosystem.

## Core DNA Rules

1. **Know the skill landscape.** Before approaching any task, understand what skills are available, what they do, and when they apply. Task-based discovery (match task type to skill category) and context-based discovery (match error patterns to debugging skills) are both valid.

2. **Match skills to task phases.** Research tasks need research skills. Implementation needs implementation skills. Verification needs verification skills. Don't use a debugging skill for feature work or a feature skill for bug investigation.

3. **Compose skills in chains, not isolation.** Common workflows: Research → Brainstorming → Execution. Debugging → Fix → Verification. Frontend Design → Performance → Verification. Every chain should end with verification.

4. **Optimize skill discoverability when creating.** Skill descriptions lead with action verbs. Triggers cover all invocation variations. Tags enable categorical search. Names are intuitive and searchable.

5. **Parallelize independent skill invocations.** If security audit, accessibility audit, and performance check are all needed, run them in parallel — not sequentially. Only serialize when skills depend on each other's output.

## Anti-Patterns

1. **Skill overload for trivial tasks.** Invoking systematic-debugging, frontend-design, react-performance, verification, AND writing-clearly to fix a typo. Match tool count to task size.
2. **Wrong skill category.** Using a debugging skill for new feature work, or a performance skill for a security concern — domain mismatch wastes time and produces bad results.
3. **Skipping verification in skill chains.** Running research → implementation without a verification step — every workflow must close the loop.

## Verification Questions

1. Does the agent select skills based on task type and phase, or does it apply the same skills regardless of context?
2. Does the agent compose skill chains that end with verification, or does it skip the validation step?
3. When creating new skills, does the agent optimize for discoverability (action verbs, comprehensive triggers, categorical tags)?
