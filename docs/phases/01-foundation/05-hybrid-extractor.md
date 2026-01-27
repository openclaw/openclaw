# Phase 1, Task 05: Hybrid Entity Extraction Pipeline

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Implement LLM-based entity extraction with delimiter fallback
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 04 (Model Abstraction)

---

## Task Overview

Implement the entity extraction pipeline that:
- Uses LLM structured output with delimiter fallback
- Supports gleaning (multi-pass extraction)
- Tracks extraction progress
- Handles retries with backoff

## Architecture Decision

**Reference:** Part 2 of `docs/plans/graphrag/ZAI-UPDATED-DESIGN.md`

Hybrid extraction strategy:
1. Try schema-based structured output
2. Fall back to delimiter parsing if structured output fails
3. Use gleaning for improved recall

## File Structure

```
src/knowledge/extraction/
├── hybrid-extractor.ts     # Main extraction orchestrator
├── prompts.ts              # Extraction prompt templates
├── gleaning.ts             # Multi-pass gleaning logic
└── hybrid-extractor.test.ts
```

## Core Implementation

**File:** `src/knowledge/extraction/hybrid-extractor.ts`

```typescript
/**
 * Hybrid entity extraction pipeline.
 *
 * Strategy:
 * 1. Attempt structured output (JSON schema / function calling)
 * 2. Fall back to delimiter parsing if structured output fails
 * 3. Optionally run gleaning passes for improved recall
 *
 * Reference: docs/plans/graphrag/ZAI-UPDATED-DESIGN.md Part 2
 */

import type {
  LanguageModel,
  ChatMessage,
  StructuredOutput,
} from '../../models/interface.js';
import type {
  EntityExtraction,
  Entity,
  Relationship,
} from '../graph/types.js';
import { EntityExtractionSchema } from '../graph/types.js';
import { buildExtractionPrompt, buildGleaningPrompt } from './prompts.js';
import { runGleaning } from './gleaning.js';

// ============================================================================
// CONFIG
// ============================================================================

export interface ExtractionConfig {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Backoff delay between retries (ms) */
  retryBackoffMs?: number;
  /** Enable gleaning (multi-pass extraction) */
  gleaning?: {
    enabled: boolean;
    passes: number;
  };
  /** Use cheaper model for retries */
  fallbackModel?: LanguageModel;
  /** Chunk size for batching */
  batchSize?: number;
  /** Concurrency for parallel extraction */
  concurrency?: number;
}

// ============================================================================
// EXTRACTOR
// ============================================================================

export class HybridExtractor {
  private model: LanguageModel;
  private config: ExtractionConfig;

  constructor(
    model: LanguageModel,
    config: ExtractionConfig = {}
  ) {
    this.model = model;
    this.config = {
      maxRetries: 3,
      retryBackoffMs: 1000,
      gleaning: { enabled: true, passes: 2 },
      batchSize: 10,
      concurrency: 3,
      ...config,
    };
  }

  /**
   * Extract entities and relationships from text.
   *
   * @param text - Input text to extract from
   * @param examples - Optional few-shot examples
   * @param config - Optional per-extraction config override
   * @returns Structured extraction result
   */
  async extract(
    text: string,
    examples?: EntityExtraction[],
    config?: ExtractionConfig
  ): Promise<StructuredOutput<EntityExtraction>> {
    const mergedConfig = { ...this.config, ...config };

    // Build extraction prompt
    const prompt = buildExtractionPrompt(text);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an expert at extracting entities and relationships from technical documentation.
Extract all relevant entities and their relationships, following the output schema exactly.`,
      },
      { role: 'user', content: prompt },
    ];

    // Attempt extraction with retry
    let result = await this.extractWithRetry(
      messages,
      examples,
      mergedConfig
    );

    // Run gleaning if enabled and initial extraction succeeded
    if (result.success && mergedConfig.gleaning?.enabled) {
      const gleaned = await this.runGleaning(
        text,
        result.data!,
        mergedConfig.gleaning.passes
      );

      if (gleaned.success) {
        // Merge gleaned results
        result = this.mergeExtractions(result, gleaned);
        result.fallbackUsed = result.fallbackUsed || gleaned.fallbackUsed;
      }
    }

    return result;
  }

  /**
   * Extract from multiple chunks in batch.
   */
  async extractBatch(
    chunks: Array<{ id: string; text: string }>,
    examples?: EntityExtraction[],
    config?: ExtractionConfig
  ): Promise<Map<string, StructuredOutput<EntityExtraction>>> {
    const results = new Map<string, StructuredOutput<EntityExtraction>>();
    const mergedConfig = { ...this.config, ...config };

    // Process in batches
    const batchSize = mergedConfig.batchSize || 10;
    const concurrency = mergedConfig.concurrency || 3;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      // Process batch with concurrency limit
      const promises = batch.map(async (chunk) => {
        const result = await this.extract(chunk.text, examples, mergedConfig);
        return { id: chunk.id, result };
      });

      // Wait for current batch (with concurrency limit)
      const batchResults = await this.processWithConcurrency(promises, concurrency);

      for (const { id, result } of batchResults) {
        results.set(id, result);
      }
    }

    return results;
  }

  // ------------------------------------------------------------------------
  // PRIVATE
  // ------------------------------------------------------------------------

  /**
   * Extract with retry logic.
   */
  private async extractWithRetry(
    messages: ChatMessage[],
    examples?: EntityExtraction[],
    config?: ExtractionConfig
  ): Promise<StructuredOutput<EntityExtraction>> {
    const mergedConfig = { ...this.config, ...config };
    const maxAttempts = mergedConfig.maxRetries || 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Use fallback model for retry attempts if available
        const model = attempt > 1 && mergedConfig.fallbackModel
          ? mergedConfig.fallbackModel
          : this.model;

        // Attempt structured extraction
        const result = await model.structuredChat(
          messages,
          EntityExtractionSchema,
          examples,
          mergedConfig
        );

        if (result.success) {
          return result;
        }

        lastError = new Error(result.error || 'Unknown error');
      } catch (error) {
        lastError = error as Error;
      }

      // Backoff before retry
      if (attempt < maxAttempts) {
        await new Promise(resolve =>
          setTimeout(resolve, mergedConfig.retryBackoffMs || 1000)
        );
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
      attempts: maxAttempts,
    };
  }

  /**
   * Run gleaning passes to find missed entities.
   */
  private async runGleaning(
    text: string,
    existing: EntityExtraction,
    passes: number
  ): Promise<StructuredOutput<EntityExtraction>> {
    const gleaned = await runGleaning(
      this.model,
      text,
      existing,
      passes
    );

    return gleaned;
  }

  /**
   * Merge two extraction results.
   */
  private mergeExtractions(
    primary: StructuredOutput<EntityExtraction>,
    secondary: StructuredOutput<EntityExtraction>
  ): StructuredOutput<EntityExtraction> {
    if (!primary.success || !secondary.success) {
      return primary;
    }

    const mergedEntities = this.mergeEntities(
      primary.data.entities,
      secondary.data.entities
    );

    const mergedRelationships = this.mergeRelationships(
      primary.data.relationships,
      secondary.data.relationships
    );

    return {
      success: true,
      data: {
        entities: mergedEntities,
        relationships: mergedRelationships,
      },
    };
  }

  /**
   * Merge entities, deduplicating by name.
   */
  private mergeEntities(
    primary: Entity[],
    secondary: Entity[]
  ): Entity[] {
    const seen = new Map<string, Entity>();

    // Add primary entities
    for (const entity of primary) {
      const key = this.entityKey(entity);
      seen.set(key, entity);
    }

    // Add secondary entities not in primary
    for (const entity of secondary) {
      const key = this.entityKey(entity);
      if (!seen.has(key)) {
        seen.set(key, entity);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Merge relationships, deduplicating by (source, target, type).
   */
  private mergeRelationships(
    primary: Relationship[],
    secondary: Relationship[]
  ): Relationship[] {
    const seen = new Map<string, Relationship>();

    // Add primary relationships
    for (const rel of primary) {
      const key = this.relationshipKey(rel);
      seen.set(key, rel);
    }

    // Add secondary relationships not in primary
    for (const rel of secondary) {
      const key = this.relationshipKey(rel);
      if (!seen.has(key)) {
        seen.set(key, rel);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Generate a unique key for entity deduplication.
   */
  private entityKey(entity: Entity): string {
    return `${entity.name}:${entity.type}`.toLowerCase();
  }

  /**
   * Generate a unique key for relationship deduplication.
   */
  private relationshipKey(rel: Relationship): string {
    return `${rel.sourceId}:${rel.targetId}:${rel.type}`.toLowerCase();
  }

  /**
   * Process promises with concurrency limit.
   */
  private async processWithConcurrency<T>(
    promises: Promise<T>[],
    concurrency: number
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const promise of promises) {
      const p = promise.then(result => {
        executing.splice(executing.indexOf(p), 1);
        return result;
      });

      results.push(p as any);
      executing.push(p as any);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }
}
```

## Extraction Prompts

**File:** `src/knowledge/extraction/prompts.ts`

```typescript
/**
 * Entity extraction prompts.
 */

import type { EntityExtraction } from '../graph/types.js';

/**
 * Build the main extraction prompt.
 */
export function buildExtractionPrompt(text: string): string {
  return `Extract entities and relationships from the following text.

## Entity Types
- person: People (developers, maintainers, users)
- org: Organizations, companies, teams
- repo: Code repositories, libraries
- concept: Technical concepts, algorithms, patterns
- tool: Software tools, databases, services
- location: Physical locations, deployment regions, API endpoints
- event: Named events, deployments, incidents
- goal: Objectives, requirements, targets
- task: Action items, TODOs, tasks
- file: Source files, documents, configs

## Relationship Types
- depends_on: A depends on B (services, libraries, resources)
- implements: A implements B (interfaces, protocols, specs)
- located_in: A is located in B (regions, servers, paths)
- created_by: A was created by B (person or org)
- related_to: General relationship between entities
- part_of: A is part of B (component, module, group)
- calls: A calls B (API calls, service invocations)
- exposes: A exposes B (endpoints, interfaces, APIs)
- uses: A uses B (tools, services, resources)
- precedes: A comes before B (temporal, sequential)

## Extraction Rules
1. Extract ALL entities mentioned in the text
2. Extract ALL relationships between entities
3. Include both explicit and implicit relationships
4. Assign strength 1-10 based on relationship importance (10 = critical)
5. Provide clear, concise descriptions

## Text to Analyze
${text}

Extract ALL entities and relationships following the schema.`;
}

/**
 * Build a gleaning prompt for finding missed entities.
 */
export function buildGleaningPrompt(
  text: string,
  alreadyExtracted: EntityExtraction
): string {
  const extractedNames = alreadyExtracted.entities.map(e => e.name).join(', ');
  const extractedPairs = alreadyExtracted.relationships.map(r =>
    `${r.sourceId} -> ${r.targetId} (${r.type})`
  ).join('\n');

  return `Review the text again and find any entities or relationships that were missed.

## Already Extracted
### Entities
${extractedNames}

### Relationships
${extractedPairs}

## Task
Find ADDITIONAL entities and relationships NOT in the list above.
Focus on:
- Minor entities mentioned in passing
- Implicit relationships not directly stated
- Entities referred to by pronouns or generic terms ("the service", "this API")
- Related entities (dependencies, related concepts, etc.)

## Text
${text}

Return ONLY new entities and relationships, following the same schema.`;
}

/**
 * Few-shot examples for extraction.
 */
export const EXTRACTION_EXAMPLES: EntityExtraction[] = [
  {
    entities: [
      {
        id: 'e1',
        name: 'Auth Service',
        type: 'concept',
        description: 'Handles JWT authentication for all components',
      },
      {
        id: 'e2',
        name: 'Redis',
        type: 'tool',
        description: 'In-memory data store used for token blacklisting',
      },
      {
        id: 'e3',
        name: 'PostgreSQL',
        type: 'tool',
        description: 'Database for user data',
      },
    ],
    relationships: [
      {
        id: 'r1',
        sourceId: 'e1',
        targetId: 'e2',
        type: 'uses',
        description: 'Auth Service uses Redis for token blacklisting',
        keywords: ['uses', 'blacklisting'],
        strength: 7,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        sourceCount: 1,
      },
      {
        id: 'r2',
        sourceId: 'e1',
        targetId: 'e3',
        type: 'uses',
        description: 'Auth Service uses PostgreSQL for user data',
        keywords: ['uses', 'user data'],
        strength: 7,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        sourceCount: 1,
      },
    ],
  },
];
```

## Gleaning Logic

**File:** `src/knowledge/extraction/gleaning.ts`

```typescript
/**
 * Multi-pass gleaning for improved entity extraction recall.
 *
 * Gleaning strategy (from LightRAG):
 * 1. Present already-extracted entities to the model
 * 2. Ask the model to find ADDITIONAL entities not in the list
 * 3. Repeat for configured number of passes
 *
 * Typically improves recall by 10-20%.
 */

import type {
  LanguageModel,
  ChatMessage,
  StructuredOutput,
} from '../../models/interface.js';
import type { EntityExtraction } from '../graph/types.js';
import { EntityExtractionSchema } from '../graph/types.js';
import { buildGleaningPrompt } from './prompts.js';

/**
 * Run gleaning passes to find missed entities.
 */
export async function runGleaning(
  model: LanguageModel,
  text: string,
  existing: EntityExtraction,
  passes: number
): Promise<StructuredOutput<EntityExtraction>> {
  let current: EntityExtraction = { ...existing };

  for (let i = 0; i < passes; i++) {
    const prompt = buildGleaningPrompt(text, current);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert at finding entities and relationships that were missed in initial extraction.',
      },
      { role: 'user', content: prompt },
    ];

    const result = await model.structuredChat(
      messages,
      EntityExtractionSchema
    );

    if (!result.success) {
      return result;
    }

    // Merge gleaned results with current
    current = mergeEntityExtraction(current, result.data);
  }

  return {
    success: true,
    data: current,
  };
}

/**
 * Merge two extractions, keeping unique entities and relationships.
 */
function mergeEntityExtraction(
  base: EntityExtraction,
  additional: EntityExtraction
): EntityExtraction {
  const entityMap = new Map<string, any>();

  // Add base entities
  for (const entity of base.entities) {
    const key = `${entity.name}:${entity.type}`.toLowerCase();
    entityMap.set(key, entity);
  }

  // Add additional entities (overwrite if duplicate)
  for (const entity of additional.entities) {
    const key = `${entity.name}:${entity.type}`.toLowerCase();
    if (!entityMap.has(key)) {
      entityMap.set(key, entity);
    }
  }

  const relationshipMap = new Map<string, any>();

  // Add base relationships
  for (const rel of base.relationships) {
    const key = `${rel.sourceId}:${rel.targetId}:${rel.type}`;
    relationshipMap.set(key, rel);
  }

  // Add additional relationships
  for (const rel of additional.relationships) {
    const key = `${rel.sourceId}:${rel.targetId}:${rel.type}`;
    if (!relationshipMap.has(key)) {
      relationshipMap.set(key, rel);
    }
  }

  return {
    entities: Array.from(entityMap.values()),
    relationships: Array.from(relationshipMap.values()),
  };
}
```

## Testing

**File:** `src/knowledge/extraction/hybrid-extractor.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HybridExtractor } from './hybrid-extractor.js';
import type { LanguageModel } from '../../models/interface.js';

describe('HybridExtractor', () => {
  it('should extract entities and relationships', async () => {
    const mockModel = {
      structuredChat: vi.fn().mockResolvedValue({
        success: true,
        data: {
          entities: [
            {
              id: 'e1',
              name: 'Test Entity',
              type: 'concept',
              description: 'A test entity',
            },
          ],
          relationships: [],
        },
      }),
    } as unknown as LanguageModel;

    const extractor = new HybridExtractor(mockModel, { gleaning: { enabled: false } });
    const result = await extractor.extract('This is a test.');

    expect(result.success).toBe(true);
    expect(result.data?.entities).toHaveLength(1);
  });

  it('should retry on failure', async () => {
    let attempts = 0;
    const mockModel = {
      structuredChat: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          return { success: false, error: 'Transient error' };
        }
        return {
          success: true,
          data: { entities: [], relationships: [] },
        };
      }),
    } as unknown as LanguageModel;

    const extractor = new HybridExtractor(mockModel, {
      maxRetries: 3,
      retryBackoffMs: 10,
      gleaning: { enabled: false },
    });

    const result = await extractor.extract('Test');

    expect(attempts).toBe(3);
    expect(result.success).toBe(true);
  });

  it('should process batches with concurrency', async () => {
    const mockModel = {
      structuredChat: vi.fn().mockResolvedValue({
        success: true,
        data: { entities: [], relationships: [] },
      }),
    } as unknown as LanguageModel;

    const extractor = new HybridExtractor(mockModel, {
      concurrency: 2,
      gleaning: { enabled: false },
    });

    const chunks = Array.from({ length: 5 }, (_, i) => ({
      id: `chunk-${i}`,
      text: `Chunk ${i}`,
    }));

    const results = await extractor.extractBatch(chunks);

    expect(results.size).toBe(5);
  });
});
```

## Success Criteria

- [ ] HybridExtractor extracts entities and relationships
- [ ] Retry logic works correctly
- [ ] Gleaning improves recall
- [ ] Batch processing respects concurrency limits
- [ ] Tests pass

## References

- Design: `docs/plans/graphrag/ZAI-UPDATED-DESIGN.md` Part 2
- LightRAG gleaning: https://github.com/HKUDS/LightRAG

## Next Task

Proceed to `06-entity-consolidation.md` to implement 3-tier deduplication.
