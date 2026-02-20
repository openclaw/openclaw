---
name: deep-reason
description: >
  Routes complex math, logic, and formal reasoning tasks to DeepSeek V3.2
  in thinking mode. Leverages DSA for long-context reasoning and RL-trained
  "thinking with tools" capability. Gold-medal IMO/IOI-level reasoning.
metadata: { "openclaw": { "emoji": "🧠" } }
---

# Deep Reason

Specialist routing for mathematical and formal reasoning via DeepSeek V3.2.

## When to Use

- Mathematical proofs and problem-solving
- Formal logic and deduction
- Algorithm design and complexity analysis
- Long-context document analysis (>100K tokens)
- Competitive programming problems
- Statistical analysis and modelling
- Any task requiring extended chain-of-thought reasoning

## Activation

- **Automatic:** Task contains equations, proofs, formal logic, or complexity_score > 0.8
- **Manual:** "prove that", "solve this math problem", "deep reasoning needed"

## Procedure

### Step 1: Route to DeepSeek V3.2 (Thinking Mode)

```bash
sessions_spawn(
  model="deepseek/deepseek-reasoner",
  task="[REASONING_TASK]",
  label="deep-reason"
)
```

### Step 2: Structured Reasoning Prompt

```
Solve the following problem using rigorous step-by-step reasoning.

## Problem
{problem}

## Requirements:
1. State all assumptions explicitly
2. Show complete reasoning chain — every logical step
3. If using a theorem or identity, name it
4. Verify your answer using an independent method (substitution, alternative proof, numerical check)
5. Rate your confidence (0.0-1.0) with justification
6. If multiple approaches exist, note the alternatives
```

### Step 3: Cross-Verification (Optional, for high-stakes)

When `verify_answer=true`, run independent verification on Opus:

```
DeepSeek V3.2 solved the following problem:

## Problem
{problem}

## DeepSeek's Solution
{deepseek_response}

Independently verify:
1. Check each logical step for validity
2. Verify the final answer using a DIFFERENT method
3. Flag any errors, gaps, or unjustified leaps
4. Verdict: VERIFIED | DISPUTED | INCONCLUSIVE
```

## When to Use DeepSeek vs Opus for Reasoning

| Task                           |    DeepSeek V3.2     |  Opus 4.6   |
| ------------------------------ | :------------------: | :---------: |
| Pure math (proofs, equations)  |      ✅ Primary      |   Verify    |
| Formal logic                   |      ✅ Primary      |   Verify    |
| Long-context reasoning (>100K) |   ✅ Primary (DSA)   |  Fallback   |
| Competitive programming        | ✅ Primary (CF 2121) |  Fallback   |
| Mixed reasoning + judgment     |       Fallback       | ✅ Primary  |
| Reasoning + tool use           |     Both strong      | Both strong |

## Fallback Chain

1. **Primary:** DeepSeek V3.2 (thinking mode)
2. **Fallback:** Opus 4.6 (adaptive thinking, effort=max)
3. **If both fail:** Kimi K2.5 (thinking mode) as last resort

## Error Handling

- DeepSeek timeout: increase to 300s for complex problems
- Reasoning chain too long: allow up to 64K output tokens
- Confidence < 0.7: auto-trigger cross-verification with Opus
- Contradictory verification: escalate to HH with both solutions

## Benchmarks (for context)

- DeepSeek AIME 2025: 89.3% | Kimi: 96.1% | Opus: ~90%
- DeepSeek Codeforces: 2121 rating
- DeepSeek MMLU-Pro: 85.0
