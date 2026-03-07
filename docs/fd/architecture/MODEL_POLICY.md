# Model Policy — Local Inference Stack

## Model Stack

### M1 Mac Studio (Primary Inference)

| Model | Size | Role | Use Cases |
|-------|------|------|-----------|
| `qwen3.5:9b` | ~6 GB | Primary workhorse | Complex reasoning, agent tasks, analysis |
| `qwen3.5:4b` | ~3 GB | Fast helper | Quick classification, content gen, simple Q&A |
| `qwen3.5:27b` | ~18 GB | Escalation | Heavy reasoning (only when 9b insufficient) |

### M4 Mac mini (Fallback)

| Model | Size | Role | Use Cases |
|-------|------|------|-----------|
| `qwen3.5:2b` | ~1.5 GB | Gateway triage | Ultra-fast routing, simple greetings, FAQ |
| `qwen3.5:4b` | ~3 GB | Fallback | When M1 is unavailable |

### Cloud (Escalation)

| Provider | Model | Use Cases |
|----------|-------|-----------|
| Anthropic | `claude-sonnet-4-6` | Complex analysis, code gen, long context |

## Routing Policy

### Default Flow
1. Inbound → M4 Gateway
2. Gateway classifies intent
3. Normal work → M1 Ollama (qwen3.5:9b)
4. Simple/cheap/fast → M4 local (qwen3.5:2b)
5. Long-running → worker queue
6. Risky → pause for approval

### Model Selection

```
if simple_greeting_or_faq:
    → M4: qwen3.5:2b       (instant, no round-trip to M1)

elif content_generation:
    → M1: qwen3.5:4b       (fast, good enough for captions/hooks)

elif normal_agent_work:
    → M1: qwen3.5:9b       (primary workhorse)

elif complex_analysis:
    → Cloud: claude-sonnet-4-6  (when local models insufficient)

elif long_running_batch:
    → Worker queue           (async, don't block chat)
```

### Failover Chain

```
M1 qwen3.5:9b (primary)
    ↓ (M1 offline)
M4 qwen3.5:4b (fallback — lighter model)
    ↓ (both offline)
Cloud claude-sonnet-4-6 (last resort)
```

## Warm-Up

Run `scripts/warm-models.sh` on M1 after boot to pre-load models into memory.
First inference after cold start can take 30-60 seconds; warm models respond in 1-3 seconds.

## Context Windows

All Qwen 3.5 models support up to 256K context window (default: 131072 in config).
Claude supports 200K context natively.

## Cost Control

- Local inference: **free** (electricity only)
- Cloud escalation: **pay-per-use** (Claude API)
- Strategy: Keep 95%+ of inference local, cloud only for edge cases
- Never auto-escalate to cloud without explicit routing rule
