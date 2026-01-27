# Phase 3, Task 02: Query Entity Recognizer

**Phase:** 3 - Hybrid GraphRAG Retrieval + Agent Tools
**Task:** Implement fast entity mention detection in queries
**Duration:** 1 day
**Complexity:** Low
**Depends on:** Phase 1 complete

---

## Task Overview

Implement entity recognition for user queries:
- Extract candidate phrases (capitalized, quoted)
- Look up in entity FTS index
- Return matched entities

## File Structure

```
src/knowledge/retrieval/
└── query-entity-recognizer.ts
```

## Implementation

```typescript
/**
 * Fast entity mention detection in queries.
 *
 * Strategy:
 * 1. Extract candidate phrases (capitalized words, noun phrases)
 * 2. Look up in entity FTS index
 * 3. Return matched entities
 */

import type { RelationalDatastore } from '../datastore/interface.js';
import type { Entity } from '../graph/types.js';

export class QueryEntityRecognizer {
  constructor(private datastore: RelationalDatastore) {}

  /**
   * Recognize entities mentioned in query text.
   */
  async recognize(query: string): Promise<Entity[]> {
    // Extract candidate phrases
    const candidates = this.extractCandidates(query);

    if (candidates.length === 0) return [];

    // Search for entities matching candidates
    const entities: Entity[] = [];

    for (const candidate of candidates) {
      const matches = await this.datastore.query<any>(
        `SELECT e.* FROM kg_entities e
         JOIN kg_entities_fts fts ON e.id = fts.rowid
         WHERE kg_entities_fts MATCH $1
         LIMIT 5`,
        [candidate]
      );

      for (const match of matches) {
        entities.push({
          id: match.id,
          name: match.name,
          type: match.type,
          description: match.description,
          /* ... */
        });
      }
    }

    return this.deduplicate(entities);
  }

  /**
   * Extract candidate entity mentions from query.
   */
  private extractCandidates(query: string): string[] {
    const candidates: string[] = [];

    // Extract capitalized phrases
    const capitalizedMatch = query.matchAll(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);

    for (const match of capitalizedMatch) {
      candidates.push(match[0]);
    }

    // Extract quoted phrases
    const quotedMatch = query.matchAll(/"([^"]+)"/g);

    for (const match of quotedMatch) {
      candidates.push(match[1]);
    }

    return Array.from(new Set(candidates));
  }

  /**
   * Deduplicate entities by name.
   */
  private deduplicate(entities: Entity[]): Entity[] {
    const seen = new Set<string>();
    const unique: Entity[] = [];

    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(entity);
      }
    }

    return unique;
  }
}
```

## Success Criteria

- [ ] Extracts capitalized phrases from queries
- [ ] Extracts quoted phrases from queries
- [ ] FTS lookup returns matching entities
- [ ] Deduplication removes duplicates
- [ ] Tests pass

## References

- Phase 3 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
