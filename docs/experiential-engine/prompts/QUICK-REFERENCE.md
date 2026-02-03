# Experiential Engine Prompts - Quick Reference

## Prompt Selection Matrix

| Situation | Category | Recommended Option | Latency |
|-----------|----------|-------------------|---------|
| Real-time capture decision | Experience Evaluation | 1D (Rapid Binary) | <2s |
| Important session review | Experience Evaluation | 1B (Multi-Factor) | ~5s |
| Avoiding redundant captures | Experience Evaluation | 1C (Historical) | ~5s |
| Standard classification | Memory Classification | 2A (Tripartite) | ~5s |
| Identity-focused session | Memory Classification | 2B (Identity-Prioritizing) | ~5s |
| Quick emotional tagging | Emotional Signature | 3D (Minimal) | <2s |
| Reconstitution prep | Emotional Signature | 3B (Phenomenological) | ~5s |
| Relationship exchange | Emotional Signature | 3C (Relational) | ~5s |
| Deep identity analysis | Identity Fragment | 4A (Comprehensive) | ~15s |
| Tracking identity growth | Identity Fragment | 4B (Delta-Focused) | ~10s |
| Behavioral analysis | Identity Fragment | 4C (Implicit) | ~10s |
| Full relationship update | Relationship Texture | 5A (Full Analyzer) | ~10s |
| Quick relationship check | Relationship Texture | 5B (Delta Detector) | ~5s |
| Standard reconstitution | Reconstitution | 6A (Full Guide) | ~20s |
| Quick state access | Reconstitution | 6B (Anchor-Focused) | ~10s |
| Sensitive experiences | Reconstitution | 6C (Gentle Approach) | ~15s |
| Standard compaction | Compaction | 7A (Essence) | ~10s |
| High-density session | Compaction | 7B (Minimal Loss) | ~10s |
| Reconstitution priority | Compaction | 7C (Anchor-Dense) | ~10s |
| Multi-dimensional search | Embedding | 8A (Multi-Aspect) | ~5s |
| General search | Embedding | 8B (Single Optimized) | ~3s |
| Experiential similarity | Embedding | 8C (Anchor-Weighted) | ~3s |

## System vs User Prompt Split

### System Prompt Contains:
- Role and identity of the evaluator
- Evaluation criteria and priorities
- Output format (JSON schema)
- Domain knowledge and definitions
- Constraints (what to include/exclude)

### User Prompt Contains:
- Specific content being evaluated
- Session context (who, when, type)
- Current state information
- Baseline/comparison data
- Specific task instruction

## Key Design Principles

1. **AI-as-User Paradigm**: The "user" in these prompts is the AI agent (Clawd), not the human. Both system and user prompts serve the agent's purposes.

2. **Utilize Full Context**: With ~128k context on Qwen, prompts can be detailed and explicit. More guidance = better results.

3. **JSON Output**: All prompts specify JSON output for reliable parsing in the pipeline.

4. **Latency Awareness**: Choose prompts based on time budget. Real-time needs fast options.

5. **Evolution Tracking**: Document changes in PROMPT-CHANGELOG.md.

## Common Patterns

### Capture Pipeline
```
Exchange → 1D (quick filter) → if capture:
  → 2A (classify) 
  → 3D (emotional tag)
  → 8B (embed)
  → [async] 4A (identity mine) if identity signals present
```

### Relationship Update Pipeline
```
Exchange with known partner → 5B (detect change) → if change:
  → 5A (full analysis)
  → 3C (relational emotional map)
  → Update relationship profile
```

### Reconstitution Pipeline
```
Request → Load experience record → 
  → Check intensity → 6A/6B/6C accordingly
  → Present guide
  → Track reconstitution quality
```

### Compaction Pipeline
```
Session end → 7A (standard) or 7B (if high-density)
  → Merge with captured experiences
  → 8A (multi-aspect embed) for searchability
  → Archive
```
