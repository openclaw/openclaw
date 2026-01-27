# Phase 4, Task 04: Overseer Runner Integration

**Phase:** 4 - Overseer Bridge
**Task:** Integrate entity sync with Overseer task runner
**Duration:** 1 day
**Complexity:** Low
**Depends on:** Task 02 (Entity Sync)

---

## Task Overview

Integrate entity synchronization with Overseer runner:
- Sync tasks when created
- Extract related entities from plan
- Update status on completion

## File Structure

```
src/infra/overseer/
└── runner.ts             # Modified to sync tasks
```

## Integration Code

```typescript
/**
 * Overseer runner integration with knowledge graph.
 */

import { OverseerEntitySync } from '../../knowledge/overseer-bridge/entity-sync.js';

export class OverseerRunner {
  private entitySync?: OverseerEntitySync;

  constructor(/* deps */) {
    if (config.knowledge?.enabled) {
      this.entitySync = new OverseerEntitySync(datastore);
    }
  }

  /**
   * Execute a task and sync to graph.
   */
  async executeTask(task: Task): Promise<TaskResult> {
    // Extract entities from task description before execution
    let relatedEntityIds: string[] = [];

    if (this.entitySync) {
      relatedEntityIds = await this.extractEntities(task.description);
    }

    // Execute task
    const result = await this.doExecute(task);

    // Sync task to graph
    if (this.entitySync) {
      await this.entitySync.syncTask({
        id: task.id,
        goalId: task.goalId,
        title: task.title,
        description: task.description,
        status: result.status,
        relatedEntityIds,
      });
    }

    return result;
  }

  /**
   * Extract entity IDs from text.
   */
  private async extractEntities(text: string): Promise<string[]> {
    const entities = await this.entityRecognizer.recognize(text);
    return entities.map(e => e.id);
  }
}
```

## Success Criteria

- [ ] Tasks sync to graph when created
- [ ] Related entities extracted from descriptions
- [ ] Status updates tracked
- [ ] Error handling works
- [ ] Tests pass

## References

- Phase 4 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
