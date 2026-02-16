# [RFC] Context-Aware Dynamic Skill Loading

## Summary

Add semantic skill indexing to reduce token consumption by 60-70% for users with many skills (10+), while maintaining full functionality.

## Problem

Users with 10+ skills face excessive token costs because ALL skill documentation loads into context for EVERY request:
- 11 skills = ~15k input tokens baseline
- Cost: $45/month (100 requests/day on Opus)
- Most skills irrelevant to each request
- Current workaround (`--disable-model-invocation`) loses context-awareness

Reported in #6691 by @bellarivialabs

## Proposed Solution

### Phase 1: Semantic Skill Indexing (MVP)

1. **Pre-index skills at startup** with embeddings (description + triggers)
2. **Two-pass loading:**
   - Load lightweight skill directory (names + 1-line descriptions)
   - On user message: semantic search → load top-k relevant skills
   - If agent calls a skill not loaded: lazy-load it
3. **Configuration:** `skills.dynamicLoading.enabled: true` (opt-in initially)

### Architecture

```typescript
// New module: src/agents/skills/semantic-index.ts
interface SkillIndex {
  name: string;
  description: string;
  triggers: string[];
  embedding: number[];
  filePath: string;
}

// Modified: src/agents/skills/workspace.ts
async function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts: {
    userMessage?: string; // NEW
    dynamicLoading?: boolean; // NEW
    topK?: number; // NEW (default: 5)
    // ... existing opts
  }
): Promise<string> {
  if (opts.dynamicLoading && opts.userMessage) {
    const relevantSkills = await semanticSearch(skillIndex, opts.userMessage, opts.topK);
    return formatPrompt({
      skillDirectory: allSkills.map(s => `${s.name}: ${s.description}`),
      loadedSkills: relevantSkills
    });
  }
  // Fall back to current behavior
  return formatSkillsForPrompt(allSkills);
}
```

### Benefits

- **60-70% token reduction** (15k → 4k baseline for 15 skills)
- **Backward compatible** (flag-gated, graceful fallback)
- **No UX changes** (transparent to users)
- **Aligns with roadmap** (Performance: token optimization)

### Implementation Plan

1. Week 1: Semantic indexing + search module
2. Week 2: Modify prompt builder, add config options
3. Week 3: Testing with beta users (opt-in flag)
4. Week 4: Documentation, telemetry, promote to default

## Alternatives Considered

1. **Manual skill selection** - too much friction for users
2. **Usage-based learning** - good future enhancement, but doesn't solve initial cold-start
3. **Async skill loading** - complex, breaks streaming

## Questions for Maintainers

1. **Embedding provider preference?** OpenAI (text-embedding-3-small) vs Anthropic vs local (sentence-transformers)?
2. **Caching strategy?** Store embeddings in `.openclaw/skills-index.json`?
3. **Backward compat concerns?** Any edge cases I'm missing?

## Testing Plan

- Load test with 20+ skills
- Benchmark token reduction across skill counts
- Verify fallback works when semantic search fails
- Test lazy-loading when agent calls unloaded skill

---

**AI-assisted:** Built with Claude Opus 4.5  
**Author:** @cheenu1092 (Chief of Staff to nagaconda)  
**Estimated effort:** 2-3 days for Phase 1 MVP
