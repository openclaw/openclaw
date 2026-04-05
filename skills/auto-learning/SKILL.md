---
name: auto-learning
description: Self-improvement engine that learns from successful code commits, extracts patterns, scores quality, and stores them as few-shot examples for future pipeline runs. Use when discussing feedback loops, self-evolution, or continuous learning.
metadata:
  openclaw:
    emoji: "🧬"
    category: ai
---

# Auto-Learning (Feedback Loop)

Self-improvement via pattern extraction from successful commits.

## Architecture

```
FeedbackLoopEngine (src/auto_learning/feedback_loop.py)
├── git diff → _extract_added_code()
├── _score_pattern() → quality heuristics (0.0-1.0)
├── _extract_tags() → semantic tags
└── → src/ai/agents/special_skills.json (max 200 patterns)
```

## Scoring Heuristics

| Factor            | Weight     | Description                     |
| ----------------- | ---------- | ------------------------------- |
| Base              | 0.5        | Starting score                  |
| Error handling    | +0.1       | try/except, Result<>, unwrap_or |
| Async patterns    | +0.05      | async/await usage               |
| Type hints        | +0.02/each | Max +0.1                        |
| Comments ratio    | +0.1       | ≥5% comment lines               |
| Reasonable length | +0.1       | 5-50 lines                      |
| Too long          | -0.05      | >50 lines                       |

## Tag Detection

Automatically tags: `async`, `error-handling`, `testing`, `api`, `parsing`, `caching`.

## Integration with Pipeline

1. **SAGE Engine** (`_sage.py`): self-evolution — analyzes Auditor feedback, generates corrections
2. **SLEA-RL StepExperience**: step-level experience in SuperMemory
3. **Counterfactual Credit**: Shapley-inspired credit for Ensemble Voting
4. **ProRL**: Process Reward Model for pipeline outcome prediction

## Pipeline Roles Using Patterns

Patterns from `special_skills.json` are injected as few-shot examples:

- Coder / Executor_Architect / Test_Writer → code patterns
- Planner / Architect / Foreman → architecture patterns

## Trigger

After each successful pipeline commit (Dmarket_bot or OpenClaw), the engine:

1. Gets `git diff` for the commit
2. Extracts added code blocks (>20 chars)
3. Scores each pattern
4. Stores if score > threshold
5. Prunes to 200 max (lowest scores removed)
