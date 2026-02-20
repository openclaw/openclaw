---
name: tri-model-verify
description: >
  Cross-model consensus verification. Runs the same prompt through Opus 4.6,
  Kimi K2.5, and DeepSeek V3.2 in parallel, then Opus arbitrates divergence
  and synthesises the optimal answer. Use for high-stakes outputs.
metadata: { "openclaw": { "emoji": "🔺" } }
---

# Tri-Model Verify

Cross-model consensus protocol for maximum-confidence outputs.

## When to Use

- Financial calculations or business-critical numbers
- Legal or compliance-related content
- Security-sensitive code or architectural decisions
- Any output sent externally without human review
- Manual trigger: "verify this with all models" or "consensus check"

## Activation

- **Automatic:** When task is tagged as `criticality: HIGH` or matches criteria-trigger rules
- **Manual:** User explicitly requests consensus

## Procedure

### Step 1: Parallel Dispatch

Spawn 3 sub-agents simultaneously, one per model:

```bash
# Opus response
sessions_spawn(agentId="opus", task="[PROMPT]", label="verify-opus")

# Kimi response
sessions_spawn(agentId="kimi", task="[PROMPT]", label="verify-kimi")

# DeepSeek response
sessions_spawn(agentId="deepseek", task="[PROMPT]", label="verify-deepseek")
```

Wait for all 3 to complete. Timeout: 120s per model. If one model fails, proceed with 2-model consensus.

### Step 2: Collect Results

Retrieve outputs from each sub-agent via `sessions_history`.

### Step 3: Arbitration (Opus)

Feed all 3 outputs to Opus with this arbitration prompt:

```
You are the arbitrator in a tri-model consensus protocol.
Three AI models independently answered the same prompt.

## Original Prompt
{prompt}

## Model A (Opus 4.6):
{opus_response}

## Model B (Kimi K2.5):
{kimi_response}

## Model C (DeepSeek V3.2):
{deepseek_response}

## Instructions:
1. Identify areas of AGREEMENT and DIVERGENCE
2. For each divergence, assess which model's answer is strongest and WHY
3. Flag any CONTRADICTIONS
4. Produce a SYNTHESISED answer taking the best from each
5. Rate confidence: VERY_HIGH | HIGH | MEDIUM | LOW | ESCALATE

Format your response as:
### Divergence Analysis
### Synthesised Answer
### Confidence: [LEVEL]
### Notes for Human Review (if any)
```

### Step 4: Output

- If confidence >= HIGH → return synthesised answer
- If confidence == MEDIUM → return answer + divergence notes
- If confidence <= LOW → escalate to HH with all 3 raw outputs

## Divergence Handling

| Level          | Condition             | Action                               |
| -------------- | --------------------- | ------------------------------------ |
| Full agreement | 3/3 match             | Accept, confidence VERY_HIGH         |
| Supermajority  | 2/3 agree, minor diff | Accept majority, note divergence     |
| Split          | 2/3 agree, major diff | Accept majority, investigate outlier |
| No agreement   | All different         | Re-prompt with clarification         |
| Contradiction  | Models contradict     | STOP — escalate to human             |

## Error Handling

- Model timeout (>120s): proceed with available models (2-model consensus)
- Model API failure: use fallback chain, retry once
- All models fail: queue task in `memory/pending-tasks.json`, notify HH
- Opus arbitration fails: return all 3 raw outputs with "ARBITRATION_FAILED" flag

## Forensic Logging

Every invocation writes to `memory/consensus-log.jsonl`:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "prompt_hash": "sha256",
  "models_used": ["opus-4.6", "kimi-k2.5", "deepseek-v3.2"],
  "divergence_level": "full_agreement|supermajority|split|no_agreement|contradiction",
  "confidence": "VERY_HIGH|HIGH|MEDIUM|LOW|ESCALATE",
  "arbitration_model": "opus-4.6",
  "result": "accepted|escalated|failed"
}
```
