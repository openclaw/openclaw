# Phase 1, Task 06: 3-Tier Entity Consolidation

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Implement entity deduplication with exact, fuzzy, and LLM confirmation
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 05 (Hybrid Extractor)

---

## Task Overview

Implement 3-tier entity consolidation to prevent graph bloat from near-duplicate entities:
1. **Tier 1:** Exact match (MD5 hash of normalized name)
2. **Tier 2:** Edit distance similarity (fast-levenshtein)
3. **Tier 3:** Embedding similarity (cosine ≥0.92)
4. **Tier 4:** LLM confirmation (opt-in for borderline cases)

## Architecture Decision

**Reference:** AD-04 in `docs/plans/graphrag/ZAI-DECISIONS.md`

## File Structure

```
src/knowledge/consolidation/
├── consolidator.ts         # Main consolidation orchestrator
├── tiers/
│   ├── exact-match.ts      # Tier 1: Exact match
│   ├── edit-distance.ts    # Tier 2: Edit distance
│   ├── embedding.ts        # Tier 3: Embedding similarity
│   └── llm-confirm.ts      # Tier 4: LLM confirmation
└── consolidator.test.ts
```

## Core Implementation

**File:** `src/knowledge/consolidation/consolidator.ts`

```typescript
/**
 * Entity consolidation - prevents graph bloat from near-duplicates.
 *
 * 3-Tier Algorithm:
 * 1. Tier 1 (Exact): MD5 hash of normalized name
 * 2. Tier 2 (Edit): Levenshtein distance ≤ threshold
 * 3. Tier 3 (Embed): Cosine similarity ≥ threshold
 * 4. Tier 4 (LLM): Optional confirmation for borderline cases
 *
 * Reference: docs/plans/graphrag/ZAI-DECISIONS.md AD-04
 */

import type { RelationalDatastore } from '../datastore/interface.js';
import type { Entity, EntityType } from '../graph/types.js';
import type { LanguageModel } from '../../models/interface.js';
import { Tier1ExactMatch } from './tiers/exact-match.js';
import { Tier2EditDistance } from './tiers/edit-distance.js';
import { Tier3EmbeddingSimilarity } from './tiers/embedding.js';
import { Tier4LLMConfirmation } from './tiers/llm-confirm.js';

// ============================================================================
// CONFIG
// ============================================================================

export interface ConsolidationConfig {
  /** Tier 1: Exact match (always enabled) */
  tier1?: {
    enabled: boolean;
  };
  /** Tier 2: Edit distance threshold */
  tier2?: {
    enabled: boolean;
    threshold: number;  // Max edit distance (default: 3)
  };
  /** Tier 3: Embedding similarity threshold */
  tier3?: {
    enabled: boolean;
    threshold: number;  // Cosine similarity (default: 0.92)
  };
  /** Tier 4: LLM confirmation for borderline cases */
  tier4?: {
    enabled: boolean;
    minSimilarity: number;  // Below this, ask LLM (default: 0.88)
    maxSimilarity: number;  // Above this, auto-merge (default: 0.92)
  };
  /** Maximum description fragments to merge */
  maxDescriptionFragments?: number;
}

export interface ConsolidationResult {
  mergedCount: number;
  canonicalIds: Map<string, string>;  // oldId -> canonicalId
  newEntities: Entity[];  // Entities that didn't match
  skipped: string[];  // IDs skipped (failed all tiers)
}

// ============================================================================
// CONSOLIDATOR
// ============================================================================

export class EntityConsolidator {
  private datastore: RelationalDatastore;
  private model?: LanguageModel;
  private config: ConsolidationConfig;

  constructor(
    datastore: RelationalDatastore,
    config: ConsolidationConfig = {}
  );

  constructor(
    datastore: RelationalDatastore,
    model: LanguageModel,
    config: ConsolidationConfig = {}
  );

  constructor(
    datastore: RelationalDatastore,
    modelOrConfig: LanguageModel | ConsolidationConfig,
    config: ConsolidationConfig = {}
  ) {
    this.datastore = datastore;

    if ('chat' in modelOrConfig) {
      this.model = modelOrConfig as LanguageModel;
      this.config = {
        tier1: { enabled: true },
        tier2: { enabled: true, threshold: 3 },
        tier3: { enabled: true, threshold: 0.92 },
        tier4: { enabled: true, minSimilarity: 0.88, maxSimilarity: 0.92 },
        maxDescriptionFragments: 5,
        ...config,
      };
    } else {
      this.config = {
        tier1: { enabled: true },
        tier2: { enabled: true, threshold: 3 },
        tier3: { enabled: true, threshold: 0.92 },
        tier4: { enabled: false },  // Disabled if no LLM
        maxDescriptionFragments: 5,
        ...modelOrConfig,
        ...config,
      };
    }
  }

  /**
   * Consolidate a batch of new entities against existing entities.
   *
   * @param newEntities - Entities to consolidate
   * @returns Consolidation result with merged entities
   */
  async consolidate(newEntities: Entity[]): Promise<ConsolidationResult> {
    const canonicalIds = new Map<string, string>();
    const consolidatedEntities: Entity[] = [];
    const skipped: string[] = [];

    // Get existing entities for comparison
    const existingEntities = await this.getExistingEntities();

    // Process each new entity
    for (const newEntity of newEntities) {
      const match = await this.findMatch(newEntity, existingEntities);

      if (match) {
        // Merge into existing entity
        await this.mergeEntity(newEntity, match);
        canonicalIds.set(newEntity.id, match.id);
      } else {
        // No match found, keep as new entity
        consolidatedEntities.push(newEntity);
      }
    }

    return {
      mergedCount: canonicalIds.size,
      canonicalIds,
      newEntities: consolidatedEntities,
      skipped,
    };
  }

  /**
   * Find a matching entity for consolidation.
   */
  private async findMatch(
    entity: Entity,
    existing: Entity[]
  ): Promise<Entity | null> {
    // Filter by type first (consolidate only within same type)
    const sameType = existing.filter(e => e.type === entity.type);

    // Tier 1: Exact match (normalized name hash)
    if (this.config.tier1?.enabled) {
      const tier1 = new Tier1ExactMatch();
      const match = tier1.findMatch(entity, sameType);
      if (match) return match;
    }

    // Tier 2: Edit distance
    if (this.config.tier2?.enabled) {
      const tier2 = new Tier2EditDistance(this.config.tier2.threshold);
      const match = tier2.findMatch(entity, sameType);
      if (match) return match;
    }

    // Tier 3: Embedding similarity
    if (this.config.tier3?.enabled && this.model) {
      const tier3 = new Tier3EmbeddingSimilarity(
        this.model,
        this.config.tier3.threshold
      );
      const result = await tier3.findMatch(entity, sameType);

      if (result.match) {
        // Tier 4: LLM confirmation for borderline cases
        if (this.config.tier4?.enabled && this.model) {
          const inBorderZone =
            result.score >= (this.config.tier4.minSimilarity || 0.88) &&
            result.score < (this.config.tier4.maxSimilarity || 0.92);

          if (inBorderZone) {
            const tier4 = new Tier4LLMConfirmation(this.model);
            const confirmed = await tier4.shouldMerge(entity, result.match!);
            return confirmed ? result.match : null;
          }
        }

        return result.match;
      }
    }

    return null;
  }

  /**
   * Merge a new entity into an existing canonical entity.
   */
  private async mergeEntity(
    newEntity: Entity,
    canonical: Entity
  ): Promise<void> {
    // Merge description fragments
    const mergedDescription = this.mergeDescriptions(
      canonical.description,
      newEntity.description
    );

    // Update canonical entity
    await this.datastore.execute(
      `UPDATE kg_entities
       SET description = $1,
           last_seen = $2,
           source_count = source_count + 1,
           merged_from = CASE
             WHEN merged_from IS NULL THEN json_array($3)
             ELSE json_array(merged_from, $3)
           END
       WHERE id = $4`,
      [
        mergedDescription,
        Math.max(canonical.lastSeen, newEntity.lastSeen),
        newEntity.id,
        canonical.id,
      ]
    );

    // Record history
    await this.recordMergeHistory(newEntity, canonical);

    // Update relationships to point to canonical entity
    await this.repointRelationships(newEntity.id, canonical.id);
  }

  /**
   * Merge description fragments.
   */
  private mergeDescriptions(
    existing?: string,
    newDesc?: string
  ): string | undefined {
    if (!newDesc) return existing;
    if (!existing) return newDesc;

    const maxFragments = this.config.maxDescriptionFragments || 5;
    const existingFragments = existing.split(' | ');
    const newFragments = newDesc.split(' | ');

    // Combine and deduplicate
    const combined = [...new Set([...existingFragments, ...newFragments])];

    // Keep only the most recent fragments
    return combined.slice(-maxFragments).join(' | ');
  }

  /**
   * Record merge in entity history.
   */
  private async recordMergeHistory(
    merged: Entity,
    canonical: Entity
  ): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_entity_history (history_id, entity_id, event, data, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `merge-${merged.id}-${Date.now()}`,
        canonical.id,
        'merged',
        JSON.stringify({ mergedFrom: merged.id }),
        Date.now(),
      ]
    );
  }

  /**
   * Repoint relationships from merged entity to canonical entity.
   */
  private async repointRelationships(
    oldId: string,
    newId: string
  ): Promise<void> {
    // Update source_id
    await this.datastore.execute(
      `UPDATE kg_relationships
       SET source_id = $1
       WHERE source_id = $2`,
      [newId, oldId]
    );

    // Update target_id
    await this.datastore.execute(
      `UPDATE kg_relationships
       SET target_id = $1
       WHERE target_id = $2`,
      [newId, oldId]
    );

    // Remove self-loops created by merge
    await this.datastore.execute(
      `DELETE FROM kg_relationships
       WHERE source_id = $1 AND target_id = $1`,
      [newId]
    );
  }

  /**
   * Get existing entities for consolidation.
   */
  private async getExistingEntities(): Promise<Entity[]> {
    const rows = await this.datastore.query<any>(
      `SELECT * FROM kg_entities
       WHERE canonical_id IS NULL  -- Only canonical entities
       ORDER BY last_seen DESC`
    );

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      nameHash: row.name_hash,
      type: row.type,
      description: row.description,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      sourceCount: row.source_count,
    }));
  }
}
```

## Tier 1: Exact Match

**File:** `src/knowledge/consolidation/tiers/exact-match.ts`

```typescript
/**
 * Tier 1: Exact match via MD5 hash of normalized name.
 *
 * Normalization:
 * - Lowercase
 * - Trim whitespace
 * - Remove punctuation
 * - Remove special characters
 *
 * Catches: "Auth Service" == "auth service" == "AuthService"
 */

import crypto from 'crypto';
import type { Entity } from '../../graph/types.js';

export class Tier1ExactMatch {
  /**
   * Find exact match for entity.
   */
  findMatch(entity: Entity, candidates: Entity[]): Entity | null {
    const hash = this.hashName(entity.name);

    for (const candidate of candidates) {
      if (this.hashName(candidate.name) === hash) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Generate MD5 hash of normalized name.
   */
  hashName(name: string): string {
    const normalized = this.normalizeName(name);
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Normalize entity name for comparison.
   */
  normalizeName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')  // Remove punctuation
      .replace(/\s+/g, ' ');     // Normalize whitespace
  }
}
```

## Tier 2: Edit Distance

**File:** `src/knowledge/consolidation/tiers/edit-distance.ts`

```typescript
/**
 * Tier 2: Edit distance (Levenshtein distance) matching.
 *
 * Catches typos and minor variations:
 * - "Auth Service" vs "Auth Servce"
 * - "Payment" vs "Paymnet"
 * - "Database" vs "DataBase"
 */

import levenshtein from 'fast-levenshtein';
import type { Entity } from '../../graph/types.js';

export class Tier2EditDistance {
  constructor(private threshold: number = 3) {}

  /**
   * Find match within edit distance threshold.
   */
  findMatch(entity: Entity, candidates: Entity[]): Entity | null {
    let bestMatch: Entity | null = null;
    let bestDistance = this.threshold + 1;

    for (const candidate of candidates) {
      const distance = levenshtein.get(
        entity.name.toLowerCase(),
        candidate.name.toLowerCase()
      );

      if (distance < bestDistance && distance <= this.threshold) {
        bestMatch = candidate;
        bestDistance = distance;
      }
    }

    return bestMatch;
  }
}
```

## Tier 3: Embedding Similarity

**File:** `src/knowledge/consolidation/tiers/embedding.ts`

```typescript
/**
 * Tier 3: Embedding similarity matching.
 *
 * Catches semantic aliases:
 * - "Auth Service" vs "Authentication Service"
 * - "Payment Handler" vs "Payment Processor"
 * - "DB" vs "Database"
 */

import type { Entity } from '../../graph/types.js';
import type { LanguageModel } from '../../../models/interface.js';

export interface EmbeddingMatchResult {
  match: Entity | null;
  score: number;
}

export class Tier3EmbeddingSimilarity {
  constructor(
    private model: LanguageModel,
    private threshold: number = 0.92
  ) {}

  /**
   * Find match with embedding similarity.
   */
  async findMatch(entity: Entity, candidates: Entity[]): Promise<EmbeddingMatchResult> {
    // Generate embedding for entity name
    const [embedding] = await this.model.embed(entity.name);

    let bestMatch: Entity | null = null;
    let bestScore = this.threshold;

    // For candidates with stored embeddings, compare
    for (const candidate of candidates) {
      if (!candidate.nameEmbedding) continue;

      const score = this.cosineSimilarity(embedding, candidate.nameEmbedding);

      if (score >= bestScore) {
        bestMatch = candidate;
        bestScore = score;
      }
    }

    // If no cached embeddings, compute on-the-fly (expensive)
    if (!bestMatch && candidates.length > 0) {
      const candidateNames = candidates.map(c => c.name);
      const embeddings = await this.model.embed(candidateNames);

      for (let i = 0; i < candidates.length; i++) {
        const score = this.cosineSimilarity(embedding, embeddings[i]);

        if (score >= bestScore) {
          bestMatch = candidates[i];
          bestScore = score;
        }
      }
    }

    return { match: bestMatch, score: bestScore };
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

## Tier 4: LLM Confirmation

**File:** `src/knowledge/consolidation/tiers/llm-confirm.ts`

```typescript
/**
 * Tier 4: LLM confirmation for borderline cases.
 *
 * Used when similarity is in ambiguous range (e.g., 0.88-0.92).
 * Asks LLM: "Are these two entities the same?"
 */

import type { Entity } from '../../graph/types.js';
import type { LanguageModel, ChatMessage } from '../../../models/interface.js';

export class Tier4LLMConfirmation {
  constructor(private model: LanguageModel) {}

  /**
   * Ask LLM if two entities should be merged.
   */
  async shouldMerge(entity1: Entity, entity2: Entity): Promise<boolean> {
    const prompt = this.buildPrompt(entity1, entity2);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert at determining if two entities refer to the same thing. Answer only with "yes" or "no".',
      },
      { role: 'user', content: prompt },
    ];

    const response = await this.model.chat(messages, { temperature: 0 });
    const normalized = response.toLowerCase().trim();

    return normalized.startsWith('yes') || normalized === 'y';
  }

  /**
   * Build prompt for LLM confirmation.
   */
  private buildPrompt(entity1: Entity, entity2: Entity): string {
    return `Should these two entities be merged as the same entity?

Entity 1:
- Name: ${entity1.name}
- Type: ${entity1.type}
- Description: ${entity1.description || 'No description'}

Entity 2:
- Name: ${entity2.name}
- Type: ${entity2.type}
- Description: ${entity2.description || 'No description'}

Consider:
- Names may be variations or aliases
- Same type should refer to same category of thing
- Descriptions may indicate same or different things
- Minor spelling differences should merge

Answer "yes" if they refer to the same thing, "no" otherwise.`;
  }
}
```

## Dependencies

```bash
pnpm add fast-levenshtein
```

## Testing

**File:** `src/knowledge/consolidation/consolidator.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { EntityConsolidator } from './consolidator.js';
import { createDatastore } from '../datastore/interface.js';

describe('EntityConsolidator', () => {
  it('should merge exact name matches', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });

    const consolidator = new EntityConsolidator(ds, {
      tier1: { enabled: true },
      tier2: { enabled: false },
      tier3: { enabled: false },
    });

    const result = await consolidator.consolidate([
      { id: 'e1', name: 'Auth Service', type: 'concept', /* ... */ },
      { id: 'e2', name: 'auth service', type: 'concept', /* ... */ },
    ]);

    expect(result.mergedCount).toBe(1);
  });

  it('should merge within edit distance threshold', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });

    const consolidator = new EntityConsolidator(ds, {
      tier1: { enabled: false },
      tier2: { enabled: true, threshold: 3 },
      tier3: { enabled: false },
    });

    const result = await consolidator.consolidate([
      { id: 'e1', name: 'Payment Handler', type: 'concept', /* ... */ },
      { id: 'e2', name: 'Paymnet Handler', type: 'concept', /* ... */ },
    ]);

    expect(result.mergedCount).toBe(1);
  });

  it('should not merge different entity types', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });

    const consolidator = new EntityConsolidator(ds);

    const result = await consolidator.consolidate([
      { id: 'e1', name: 'Redis', type: 'concept', /* ... */ },
      { id: 'e2', name: 'Redis', type: 'tool', /* ... */ },
    ]);

    expect(result.mergedCount).toBe(0);
    expect(result.newEntities).toHaveLength(2);
  });
});
```

## Success Criteria

- [ ] Tier 1 exact match works
- [ ] Tier 2 edit distance catches typos
- [ ] Tier 3 embedding similarity finds aliases
- [ ] Tier 4 LLM confirmation works (opt-in)
- [ ] Consolidation repoints relationships correctly
- [ ] Self-loops removed after merge
- [ ] Tests pass

## References

- Decision AD-04: `docs/plans/graphrag/ZAI-DECISIONS.md`
- Levenshtein: https://en.wikipedia.org/wiki/Levenshtein_distance
- Cosine similarity: https://en.wikipedia.org/wiki/Cosine_similarity

## Phase 1 Complete

After completing this task, **Phase 1: Foundation** is complete.

**Next Phase:** `docs/phases/02-ingestion-crawler/01-ingestion-pipeline.md`
