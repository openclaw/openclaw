# Phase 4, Task 03: Planner Graph Context Injection

**Phase:** 4 - Overseer Bridge
**Task:** Inject graph context into Overseer planning prompts
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 02 (Entity Sync)

---

## Task Overview

Implement graph context injection for Overseer planner:
- Recognize entities in goal description
- Fetch related entities and relationships
- Format context for planning prompt
- Inject into planning LLM call

## File Structure

```
src/knowledge/overseer-bridge/
└── planner-injection.ts   # Graph context for planning
```

## Implementation

```typescript
/**
 * Inject graph context into Overseer planning prompts.
 */

import type { GraphQueryEngine } from '../graph/query.js';
import { QueryEntityRecognizer } from '../retrieval/query-entity-recognizer.js';

export class PlannerGraphInjection {
  private entityRecognizer: QueryEntityRecognizer;

  constructor(private graphQuery: GraphQueryEngine) {
    this.entityRecognizer = new QueryEntityRecognizer(graphQuery['datastore']);
  }

  /**
   * Build graph context for planning prompt.
   */
  async buildContext(goalDescription: string): Promise<string> {
    const context: string[] = [];

    // Recognize entities in goal
    const queryEntities = await this.entityRecognizer.recognize(goalDescription);

    if (queryEntities.length === 0) {
      return '';
    }

    context.push('## Relevant Knowledge Graph Entities\n');

    for (const entity of queryEntities) {
      // Get neighborhood
      const neighborhood = await this.graphQuery.getNeighborhood(entity.id, {
        maxHops: 1,
        limit: 10,
      });

      context.push(`### ${entity.name} (${entity.type})`);
      if (entity.description) {
        context.push(entity.description);
      }

      // List related entities
      if (neighborhood.relationships.length > 0) {
        context.push('\n**Related entities:**');
        for (const { targetEntity, relationship } of neighborhood.relationships.slice(0, 5)) {
          context.push(`- ${targetEntity.name} (${relationship.type})`);
        }
      }

      // Check for active goals
      const goals = await this.findActiveGoals(entity.id);
      if (goals.length > 0) {
        context.push('\n**Active goals:**');
        for (const goal of goals) {
          context.push(`- ${goal.title}`);
        }
      }

      context.push('');
    }

    return context.join('\n');
  }

  /**
   * Find active goals for an entity.
   */
  private async findActiveGoals(entityId: string): Promise<Array<{ title: string }>> {
    const results = await this.graphQuery['datastore'].query<any>(
      `SELECT e.name as title
       FROM kg_entities e
       JOIN kg_relationships r ON r.source_id = e.id
       WHERE r.target_id = $1
         AND e.type = 'goal'
       ORDER BY e.last_seen DESC
       LIMIT 5`,
      [entityId]
    );

    return results;
  }

  /**
   * Inject context into planning prompt template.
   */
  injectIntoPrompt(prompt: string, context: string): string {
    if (!context) {
      return prompt;
    }

    // Inject context before the task description
    const contextSection = `\n${context}\n`;

    // Find where to inject (before "Create a plan")
    const injectPoint = prompt.indexOf('Create a plan');
    if (injectPoint > 0) {
      return prompt.slice(0, injectPoint) + contextSection + prompt.slice(injectPoint);
    }

    return contextSection + prompt;
  }
}
```

## Integration with Overseer Planner

```typescript
// In OverseerPlanner class

import { PlannerGraphInjection } from '../../knowledge/overseer-bridge/planner-injection.js';

export class OverseerPlanner {
  private graphInjection?: PlannerGraphInjection;

  constructor(/* deps */) {
    // Initialize graph injection if knowledge enabled
    if (config.knowledge?.enabled) {
      this.graphInjection = new PlannerGraphInjection(graphQuery);
    }
  }

  async generatePlan(goal: Goal): Promise<Plan> {
    let prompt = this.buildPrompt(goal);

    // Add graph context if available
    if (this.graphInjection) {
      const context = await this.graphInjection.buildContext(goal.description);
      prompt = this.graphInjection.injectIntoPrompt(prompt, context);
    }

    // Generate plan
    const plan = await this.llm.generate(prompt);

    return plan;
  }
}
```

## Success Criteria

- [ ] Entities recognized in goal descriptions
- [ ] Related entities fetched
- [ ] Active goals found for entities
- [ ] Context formatted correctly
- [ ] Context injected into prompt
- [ ] Planner uses enhanced prompt
- [ ] Tests pass

## References

- Phase 4 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
