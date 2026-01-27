# Phase 4, Task 02: Goal/Task Entity Synchronization

**Phase:** 4 - Overseer Bridge
**Task:** Implement synchronization of goals and tasks to graph entities
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Phase 1 complete

---

## Task Overview

Implement synchronization logic that:
- Creates/updates goal entities in graph
- Creates/updates task entities in graph
- Links goals/tasks to related entities
- Records history of changes

## File Structure

```
src/knowledge/overseer-bridge/
└── entity-sync.ts         # Goal/task entity synchronization
```

## Implementation

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
      const goalEntityId = `goal-${goal.id}`;

      // Create/update goal entity
      await tx.execute(
        `INSERT INTO kg_entities (id, name, name_hash, type, description, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO UPDATE SET
           name = $2,
           description = $5,
           last_seen = $7`,
        [
          goalEntityId,
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
              goalEntityId,
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
          goalEntityId,
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
   * Update goal status.
   */
  async updateGoalStatus(goalId: string, status: string): Promise<void> {
    const goalEntityId = `goal-${goalId}`;

    await this.datastore.execute(
      `UPDATE kg_entities
       SET last_seen = $1
       WHERE id = $2`,
      [Date.now(), goalEntityId]
    );

    await this.datastore.execute(
      `INSERT INTO kg_entity_history (history_id, entity_id, event, data, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `history-goal-${goalId}-status-${Date.now()}`,
        goalEntityId,
        'updated',
        JSON.stringify({ goalId, status }),
        Date.now(),
      ]
    );
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
      status: 'active',
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

## Success Criteria

- [ ] Goals sync to graph as entities
- [ ] Tasks sync to graph as entities
- [ ] Goals link to related entities
- [ ] Tasks link to goals and related entities
- [ ] Status updates tracked in history
- [ ] findGoalsForEntity works
- [ ] findTasksForEntity works
- [ ] Tests pass

## References

- Phase 4 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
