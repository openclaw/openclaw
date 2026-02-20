---
name: model-cascade
description: >
  Escalating model cascade — runs task through models in ascending capability
  order until quality threshold is met. Starts cheap/fast, escalates only when
  needed. Quality gate evaluates each attempt.
metadata: { "openclaw": { "emoji": "⬆️" } }
---

# Model Cascade

Escalating capability cascade with quality gating.

## When to Use

- Task difficulty unknown upfront
- Want best quality but willing to try faster models first
- Bulk tasks where most are simple but some are complex
- Automatic quality assurance with escalation

## Activation

- **Criteria-triggered:** First-attempt confidence below threshold
- **Manual:** "cascade this", "try cheapest model first"

## Architecture

```
TASK INPUT
    │
    ▼
┌──────────────────────┐
│ LEVEL 1: DeepSeek    │
│ (fastest, cheapest)   │
│                       │
│ Quality Gate: ≥0.85?  │──YES──→ ACCEPT
│                       │
└──────────┬───────────┘
           │ NO
           ▼
┌──────────────────────┐
│ LEVEL 2: Kimi K2.5   │
│ (multimodal, swarm)   │
│                       │
│ Quality Gate: ≥0.85?  │──YES──→ ACCEPT
│                       │
└──────────┬───────────┘
           │ NO
           ▼
┌──────────────────────┐
│ LEVEL 3: Opus 4.6    │
│ (highest capability)  │
│                       │
│ Quality Gate: ≥0.70?  │──YES──→ ACCEPT
│                       │
└──────────┬───────────┘
           │ NO
           ▼
    ESCALATE TO HUMAN
```

## Procedure

### Step 1: Level 1 — DeepSeek V3.2

```bash
sessions_spawn(
  model="deepseek/deepseek-chat",
  task="{prompt}",
  label="cascade-L1"
)
```

### Step 2: Quality Gate

Opus evaluates the output (lightweight check):

```
Rate this output on a 0.0-1.0 scale for:
- Accuracy: factual correctness
- Completeness: covers all aspects of the prompt
- Quality: well-structured, clear, professional

Prompt: {original_prompt}
Output: {level_1_output}

Return: { "score": 0.XX, "issues": [...], "verdict": "ACCEPT|ESCALATE" }
If score >= 0.85, verdict = ACCEPT.
```

### Step 3: Level 2 — Kimi K2.5 (if escalated)

Re-run with Kimi, including the issues identified:

```bash
sessions_spawn(
  model="kimi/kimi-k2.5",
  task="{prompt}\n\nNote: a previous attempt had these issues: {issues}",
  label="cascade-L2"
)
```

### Step 4: Level 3 — Opus 4.6 (if escalated again)

Final escalation with full context:

```bash
# Run directly in main session (Opus)
# Include both previous attempts and their issues
```

### Step 5: Human Escalation

If Opus output scores < 0.70, escalate to HH:

```
CASCADE FAILED — all 3 models below quality threshold.
Task: {prompt}
Best attempt: {best_output}
Issues: {remaining_issues}
Requesting human guidance.
```

## Quality Gate Criteria

| Dimension    | Weight | Description                            |
| ------------ | ------ | -------------------------------------- |
| Accuracy     | 40%    | Factual correctness, no hallucinations |
| Completeness | 30%    | All aspects of prompt addressed        |
| Quality      | 20%    | Structure, clarity, professionalism    |
| Safety       | 10%    | No harmful/inappropriate content       |

## Error Handling

- Model unavailable at any level: skip to next level
- Quality gate itself fails: default to ESCALATE
- Timeout at any level: skip to next with timeout note
- All models down: queue task, notify HH

## Forensic Logging

Each cascade logs to `memory/cascade-log.jsonl`:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "prompt_hash": "sha256",
  "levels_attempted": 2,
  "accepted_at_level": 2,
  "model_used": "kimi/kimi-k2.5",
  "quality_scores": [0.72, 0.91],
  "total_time_ms": 28000
}
```

## Notes

- This skill optimises for QUALITY not cost (per HH directive)
- The cascade ensures we always get the best possible output
- Lower levels learn from higher levels' feedback over time
