# Phase 3, Task 03: Context Formatter

**Phase:** 3 - Hybrid GraphRAG Retrieval + Agent Tools
**Task:** Implement structured context formatting for LLM consumption
**Duration:** 0.5 day
**Complexity:** Low
**Depends on:** Task 01 (Hybrid Retrieval)

---

## Task Overview

Implement context formatter that:
- Formats retrieved chunks with sources
- Formats entity descriptions
- Formats relationship information
- Respects token limits

## File Structure

```
src/knowledge/retrieval/
└── context-formatter.ts
```

## Implementation

```typescript
/**
 * Format retrieved context for LLM consumption.
 *
 * Formats:
 * - Chunks with sources
 * - Entity descriptions
 * - Relationship information
 */

export interface ContextFormatterOptions {
  maxTokens: number;
  includeRelationships: boolean;
  includeSources: boolean;
}

export interface FormattedContext {
  text: string;
  tokens: number;
  sources: Array<{ type: string; id?: string; name?: string }>;
}

export class ContextFormatter {
  constructor(private options: ContextFormatterOptions) {}

  /**
   * Format retrieval results for LLM.
   */
  format(
    chunks: Array<{ content: string; score: number; source: any }>,
    graphContext?: { entities: any[]; relationships: any[] }
  ): FormattedContext {
    const parts: string[] = [];
    const sources: FormattedContext['sources'] = [];

    // Add entity context if available
    if (graphContext && graphContext.entities.length > 0) {
      const entitySection = this.formatEntities(graphContext.entities);
      parts.push(entitySection.text);
      sources.push(...entitySection.sources);
    }

    // Add chunks
    for (const chunk of chunks) {
      parts.push(`[Score: ${chunk.score.toFixed(2)}]\n${chunk.content}\n`);

      if (this.options.includeSources) {
        if (chunk.source.type === 'graph' && chunk.source.entity) {
          sources.push({
            type: 'entity',
            id: chunk.source.entity.id,
            name: chunk.source.entity.name,
          });
        } else {
          sources.push({ type: 'chunk' });
        }
      }
    }

    return {
      text: parts.join('\n---\n\n'),
      tokens: this.estimateTokens(parts.join('\n')),
      sources,
    };
  }

  /**
   * Format entity descriptions.
   */
  private formatEntities(entities: any[]): { text: string; sources: any[] } {
    const parts: string[] = [];
    const sources: any[] = [];

    for (const entity of entities) {
      parts.push(`**${entity.name}** (${entity.type})`);
      if (entity.description) {
        parts.push(entity.description);
      }
      sources.push({ type: 'entity', id: entity.id, name: entity.name });
    }

    return {
      text: '## Related Entities\n\n' + parts.join('\n\n') + '\n\n',
      sources,
    };
  }

  /**
   * Estimate token count (rough approximation).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

## Success Criteria

- [ ] Context formatted with sections
- [ ] Entity descriptions included
- [ ] Relationship info included when enabled
- [ ] Sources tracked
- [ ] Token estimation works
- [ ] Tests pass

## References

- Phase 3 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
