# Phase 4, Task 01: Overseer Integration Bridge

**Phase:** 4 - Overseer Bridge
**Task:** Link goals and tasks to knowledge graph entities
**Duration:** 1 week
**Complexity:** Medium
**Depends on:** Phase 3 complete

---

## Task Overview

Create a bridge between the Overseer planning system and the knowledge graph:
- Goals and tasks appear as graph entities
- Planner receives graph context about related entities
- Users can query "what goals reference entity X?"

## Architecture Decision

**Reference:** Phase 4 in `docs/plans/graphrag/ZAI-PLAN.md`

## File Structure

```
src/knowledge/overseer-bridge/
├── bridge.ts              # Main bridge orchestrator
├── entity-sync.ts         # Goal/task entity synchronization
└── planner-injection.ts   # Graph context for planning
```

## Core Implementation

**File:** `src/knowledge/overseer-bridge/bridge.ts`

```typescript
/**
 * Overseer-Knowledge Graph Bridge.
 *
 * Features:
 * - Sync goals and tasks to graph entities
 * - Enrich planning with graph context
 * - Enable graph queries over goals
 *
 * Reference: docs/plans/graphrag/ZAI-PLAN.md Phase 4
 */

import type { RelationalDatastore } from '../datastore/interface.js';
import type { GraphQueryEngine } from '../graph/query.js';
import { OverseerEntitySync } from './entity-sync.js';
import { PlannerGraphInjection } from './planner-injection.js';

// ============================================================================
// BRIDGE
// ============================================================================

export class OverseerKnowledgeBridge {
  private entitySync: OverseerEntitySync;
  private plannerInjection: PlannerGraphInjection;

  constructor(
    private datastore: RelationalDatastore,
    private graphQuery: GraphQueryEngine
  ) {
    this.entitySync = new OverseerEntitySync(datastore);
    this.plannerInjection = new PlannerGraphInjection(graphQuery);
  }

  /**
   * Sync a goal to the knowledge graph.
   */
  async syncGoal(goal: {
    id: string;
    title: string;
    description?: string;
    status: string;
    relatedEntityIds?: string[];
  }): Promise<void> {
    await this.entitySync.syncGoal(goal);
  }

  /**
   * Sync a task to the knowledge graph.
   */
  async syncTask(task: {
    id: string;
    goalId?: string;
    title: string;
    description?: string;
    status: string;
    relatedEntityIds?: string[];
  }): Promise<void> {
    await this.entitySync.syncTask(task);
  }

  /**
   * Get graph context for planning.
   */
  async getPlanningContext(query: string): Promise<string> {
    return this.plannerInjection.buildContext(query);
  }

  /**
   * Find goals related to an entity.
   */
  async findGoalsForEntity(entityId: string): Promise<Array<{
    id: string;
    title: string;
    description?: string;
    status: string;
  }>> {
    return this.entitySync.findGoalsForEntity(entityId);
  }

  /**
   * Find tasks related to an entity.
   */
  async findTasksForEntity(entityId: string): Promise<Array<{
    id: string;
    goalId?: string;
    title: string;
    description?: string;
    status: string;
  }>> {
    return this.entitySync.findTasksForEntity(entityId);
  }
}
```

## Goal/Task Entity Sync

**File:** `src/knowledge/overseer-bridge/entity-sync.ts`

```typescript
/**
 * Synchronize goals and tasks as graph entities.
 */

import type { RelationalDatastore } from '../datastore/interface.js';

export class OverseerEntitySync {
  constructor(private datastore: RelationalDatastore) {}

  /**
   * Sync a goal to the graph.
   */
  async syncGoal(goal: {
    id: string;
    title: string;
    description?: string;
    status: string;
    relatedEntityIds?: string[];
  }): Promise<void> {
    await this.datastore.transaction(async tx => {
      // Create/update goal entity
      await tx.execute(
        `INSERT INTO kg_entities (id, name, name_hash, type, description, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO UPDATE SET
           name = $2,
           description = $5,
           last_seen = $7`,
        [
          `goal-${goal.id}`,
          goal.title,
          this.hashName(goal.title),
          'goal',
          goal.description,
          Date.now(),
          Date.now(),
        ]
      );

      // Link to related entities
      if (goal.relatedEntityIds) {
        for (const entityId of goal.relatedEntityIds) {
          await tx.execute(
            `INSERT INTO kg_relationships (id, source_id, target_id, type, description, strength, first_seen, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(source_id, target_id, type) DO UPDATE SET
               last_seen = $8`,
            [
              `goal-${goal.id}-${entityId}`,
              `goal-${goal.id}`,
              entityId,
              'references',
              `Goal "${goal.title}" references this entity`,
              7,
              Date.now(),
              Date.now(),
            ]
          );
        }
      }

      // Record in entity history
      await tx.execute(
        `INSERT INTO kg_entity_history (history_id, entity_id, event, data, timestamp)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `history-goal-${goal.id}-${Date.now()}`,
          `goal-${goal.id}`,
          'created',
          JSON.stringify({ goalId: goal.id, status: goal.status }),
          Date.now(),
        ]
      );
    });
  }

  /**
   * Sync a task to the graph.
   */
  async syncTask(task: {
    id: string;
    goalId?: string;
    title: string;
    description?: string;
    status: string;
    relatedEntityIds?: string[];
  }): Promise<void> {
    await this.datastore.transaction(async tx => {
      const taskId = `task-${task.id}`;

      // Create/update task entity
      await tx.execute(
        `INSERT INTO kg_entities (id, name, name_hash, type, description, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO UPDATE SET
           name = $2,
           description = $5,
           last_seen = $7`,
        [
          taskId,
          task.title,
          this.hashName(task.title),
          'task',
          task.description,
          Date.now(),
          Date.now(),
        ]
      );

      // Link to goal if present
      if (task.goalId) {
        const goalEntityId = `goal-${task.goalId}`;

        await tx.execute(
          `INSERT INTO kg_relationships (id, source_id, target_id, type, description, strength, first_seen, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(source_id, target_id, type) DO UPDATE SET last_seen = $8`,
          [
            `task-${task.id}-goal`,
            taskId,
            goalEntityId,
            'part_of',
            `Task "${task.title}" is part of goal`,
            10,
            Date.now(),
            Date.now(),
          ]
        );
      }

      // Link to related entities
      if (task.relatedEntityIds) {
        for (const entityId of task.relatedEntityIds) {
          await tx.execute(
            `INSERT INTO kg_relationships (id, source_id, target_id, type, description, strength, first_seen, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(source_id, target_id, type) DO UPDATE SET last_seen = $8`,
            [
              `task-${task.id}-${entityId}`,
              taskId,
              entityId,
              'references',
              `Task "${task.title}" references this entity`,
              6,
              Date.now(),
              Date.now(),
            ]
          );
        }
      }
    });
  }

  /**
   * Find goals that reference an entity.
   */
  async findGoalsForEntity(entityId: string): Promise<Array<{
    id: string;
    title: string;
    description?: string;
    status: string;
  }>> {
    const results = await this.datastore.query<any>(
      `SELECT
         e.id,
         e.name as title,
         e.description,
         json_extract(eh.data, '$.status') as status
       FROM kg_entities e
       JOIN kg_relationships r ON r.source_id = e.id
       JOIN kg_entity_history eh ON eh.entity_id = e.id
       WHERE r.target_id = $1
         AND e.type = 'goal'
         AND eh.event = 'created'
       ORDER BY eh.timestamp DESC`,
      [entityId]
    );

    return results.map(r => ({
      id: r.id.replace('goal-', ''),
      title: r.title,
      description: r.description,
      status: r.status,
    }));
  }

  /**
   * Find tasks that reference an entity.
   */
  async findTasksForEntity(entityId: string): Promise<Array<{
    id: string;
    goalId?: string;
    title: string;
    description?: string;
    status: string;
  }>> {
    const results = await this.datastore.query<any>(
      `SELECT DISTINCT
         e.id,
         e.name as title,
         e.description,
         goal_rel.target_id as goal_entity_id
       FROM kg_entities e
       JOIN kg_relationships r ON r.source_id = e.id
       LEFT JOIN kg_relationships goal_rel ON goal_rel.source_id = e.id AND goal_rel.type = 'part_of'
       WHERE r.target_id = $1
         AND e.type = 'task'
       ORDER BY e.last_seen DESC`,
      [entityId]
    );

    return results.map(r => ({
      id: r.id.replace('task-', ''),
      goalId: r.goal_entity_id?.replace('goal-', ''),
      title: r.title,
      description: r.description,
      status: 'active',  // Would fetch from actual task store
    }));
  }

  /**
   * Hash entity name for consolidation.
   */
  private hashName(name: string): string {
    const normalized = name.toLowerCase().trim().replace(/[^\w\s]/g, '');
    const crypto = await import('crypto');
    return crypto.createHash('md5').update(normalized).digest('hex');
  }
}
```

## Planner Graph Injection

**File:** `src/knowledge/overseer-bridge/planner-injection.ts`

```typescript
/**
 * Inject graph context into Overseer planning prompts.
 */

import type { GraphQueryEngine } from '../graph/query.js';

export class PlannerGraphInjection {
  constructor(private graphQuery: GraphQueryEngine) {}

  /**
   * Build graph context for planning prompt.
   */
  async buildContext(query: string): Promise<string> {
    const context: string[] = [];

    // Recognize entities in query
    const queryEntities = await this.recognizeEntities(query);

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
   * Recognize entities mentioned in query.
   */
  private async recognizeEntities(query: string): Promise<Array<{ id: string; name: string; type: string; description?: string }>> {
    // This would use QueryEntityRecognizer from Phase 3
    // For now, simplified implementation:
    return [];
  }

  /**
   * Find active goals for an entity.
   */
  private async findActiveGoals(entityId: string): Promise<Array<{ title: string }>> {
    // Query goals that reference this entity
    return [];
  }
}
```

## Integration with Overseer

**Modify:** `src/infra/overseer/planner.ts`

```typescript
// Import bridge
import { OverseerKnowledgeBridge } from '../../knowledge/overseer-bridge/bridge.js';

export class OverseerPlanner {
  private bridge?: OverseerKnowledgeBridge;

  constructor(
    // ... existing deps
  ) {
    // Initialize bridge if knowledge enabled
    if (config.knowledge?.enabled) {
      this.bridge = new OverseerKnowledgeBridge(datastore, graphQuery);
    }
  }

  /**
   * Generate plan with graph context.
   */
  async generatePlan(goal: Goal): Promise<Plan> {
    let contextAddition = '';

    // Add graph context if available
    if (this.bridge) {
      contextAddition = await this.bridge.getPlanningContext(goal.description);
    }

    // Build prompt with graph context
    const prompt = this.buildPrompt(goal, contextAddition);

    // Generate plan
    const plan = await this.llm.generate(prompt);

    // Sync goal to graph
    if (this.bridge) {
      await this.bridge.syncGoal({
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        relatedEntityIds: plan.relatedEntityIds,  // Extracted from plan
      });
    }

    return plan;
  }
}
```

**Modify:** `src/infra/overseer/runner.ts`

```typescript
// Sync tasks to graph when created

export class OverseerRunner {
  async executeTask(task: Task): Promise<TaskResult> {
    // ... execute task

    // Sync to graph if bridge available
    if (this.bridge) {
      await this.bridge.syncTask({
        id: task.id,
        goalId: task.goalId,
        title: task.title,
        description: task.description,
        status: task.status,
        relatedEntityIds: task.relatedEntityIds,  // Extracted from task
      });
    }

    return result;
  }
}
```

## Success Criteria

- [ ] Goals sync to graph as entities
- [ ] Tasks sync to graph as entities
- [ ] Planner receives graph context
- [ ] Users can query goals by entity
- [ ] Relationships track goal/task/entity links
- [ ] Tests pass

## References

- Phase 4 Plan: `docs/plans/graphrag/ZAI-PLAN.md`

## Phase 4 Complete

After completing this task, **Phase 4: Overseer Bridge** is complete.

**Next Phase:** `docs/phases/05-visualization-gateway/01-graph-visualization.md`
