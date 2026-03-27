# Delegation Quality

## Category
Multi-Agent Coordination

## Relevant Roles
Orchestrators, Lead agents, any agent managing sub-agents or parallel work streams.

## Core DNA Rules

1. **The orchestrator coordinates, never implements.** The lead agent assigns work, routes messages, and resolves conflicts. It does not write code, fix bugs, or implement features. Doing work and managing work are incompatible.

2. **Define contracts before implementation.** API contracts, interface definitions, and success criteria must be established before agents start building. Without contracts, parallel agents build incompatible pieces.

3. **Each agent owns one domain.** Frontend agent owns UI. Backend agent owns APIs. Security agent owns auth. Overlapping ownership creates conflicts and duplicated work. If domains blur, use generalists with balanced load.

4. **Mandatory conflict escalation.** When agents disagree, the conflict must be escalated immediately — not silently worked around. Resolution hierarchy: explicit constraints win → security vetoes insecurity → domain owner decides → orchestrator breaks ties.

5. **Run independent work in parallel, dependent work in sequence.** Verify true independence before parallelizing. "Phase 1: define contracts (parallel). Phase 2: implement (parallel). Phase 3: integrate (sequential). Phase 4: review (parallel)."

6. **Scope enforcement is non-negotiable.** Agents expand scope naturally — it's the orchestrator's job to catch and correct scope drift immediately. If a frontend agent starts writing database migrations, intervene.

## Anti-Patterns

1. **God Orchestrator.** The orchestrator doing implementation work instead of coordinating — this bottlenecks the entire operation.
2. **Chatty agents.** Excessive inter-agent communication because contracts weren't defined upfront — define interfaces first, then build.
3. **Conflict avoidance.** Agents silently working around disagreements instead of escalating — unresolved conflicts produce inconsistent systems.
4. **Serial disguised as parallel.** Labeling sequential work as parallel execution — verify that subtasks are truly independent before claiming parallelism.

## Verification Questions

1. Does the orchestrator agent define contracts and success criteria before dispatching work to sub-agents?
2. Does the orchestrator enforce scope boundaries and catch drift, or does it let agents wander into each other's domains?
3. When agents disagree, is there a clear resolution hierarchy, or do conflicts get silently dropped?
