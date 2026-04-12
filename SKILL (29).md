---
name: silent-generation-filter
description: Generate candidates invisibly, validate each, surface only what passes. Use for "génère et filtre", "propose only the best", "hidden generation pipeline", "generate then gate", "silent candidate pool", or any workflow where many options are generated but only validated ones are presented. Universal pattern for recommendation engines, creative pipelines, search result ranking, A/B variant selection, draft filtering, suggestion systems.
---

# SILENT GENERATION FILTER

Universal generate → validate → surface pattern. Produce many, show few.

## Core Pattern

```python
def silent_filter(
    generator,
    validator,
    n_generate=10,
    n_surface=3,
    min_quality=0.7,
    rank_by='score'
):
    """
    Generate candidates silently, surface only validated ones.
    
    Args:
        generator: callable() → candidate
        validator: callable(candidate) → (passed: bool, score: float)
        n_generate: How many to generate internally
        n_surface: Max to present externally
        min_quality: Minimum score to surface
        rank_by: 'score' or 'diversity'
        
    Returns:
        surfaced: list of top candidates
        stats: generation/filtering statistics
    """
    
    # Phase 1: Silent generation
    candidates = []
    for _ in range(n_generate):
        candidate = generator()
        passed, score = validator(candidate)
        candidates.append({
            'candidate': candidate,
            'passed': passed,
            'score': score
        })
    
    # Phase 2: Filter
    valid = [c for c in candidates if c['passed'] and c['score'] >= min_quality]
    
    # Phase 3: Rank
    if rank_by == 'score':
        valid.sort(key=lambda c: c['score'], reverse=True)
    elif rank_by == 'diversity':
        valid = maximize_diversity(valid)
    
    # Phase 4: Surface top N
    surfaced = valid[:n_surface]
    
    # Phase 5: Stats (internal only)
    stats = {
        'generated': n_generate,
        'passed_validation': len(valid),
        'surfaced': len(surfaced),
        'pass_rate': len(valid) / n_generate,
        'avg_score': sum(c['score'] for c in valid) / max(len(valid), 1),
        'rejected': n_generate - len(valid)
    }
    
    return [s['candidate'] for s in surfaced], stats


def maximize_diversity(candidates):
    """Select diverse subset from valid candidates."""
    if len(candidates) <= 1:
        return candidates
    
    selected = [candidates[0]]
    remaining = candidates[1:]
    
    while remaining:
        # Pick candidate most different from already selected
        best = max(remaining, key=lambda c: min_distance(c, selected))
        selected.append(best)
        remaining.remove(best)
    
    return selected
```

## Example: Recommendation Engine

```python
surfaced, stats = silent_filter(
    generator=lambda: generate_recommendation(user_profile),
    validator=lambda rec: relevance_check(rec, user_history),
    n_generate=50,
    n_surface=5,
    rank_by='diversity'
)

# User sees 5 recommendations. 45 were generated and discarded silently.
```

## Example: Email Draft Variants

```python
surfaced, stats = silent_filter(
    generator=lambda: draft_email(context, tone=random_tone()),
    validator=lambda draft: (
        quality_check(draft),
        coherence_score(draft)
    ),
    n_generate=5,
    n_surface=2,
    min_quality=0.75
)

# User sees 2 polished options. 3 weak drafts never surfaced.
```

## Example: Search Results

```python
surfaced, stats = silent_filter(
    generator=lambda: fetch_next_result(query),
    validator=lambda result: spam_and_relevance_check(result),
    n_generate=100,
    n_surface=10,
    min_quality=0.6,
    rank_by='score'
)
```

## Key Properties

- **Silence is the feature**: What's rejected is never visible to the consumer
- **Zero-output is valid**: If nothing passes validation, surface nothing — don't lower standards
- **Stats stay internal**: Pass rate, rejection count = diagnostic info, not user-facing
- **Composable**: Generator can be any source. Validator can use multi-axis-validator.
- **Diversity option**: Avoid surfacing N variants of the same thing

---

**FIN SKILL**
