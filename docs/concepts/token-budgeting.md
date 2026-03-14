# Token Budgeting Strategy Guide

*By Dr. Metabo — Treating context windows as living metabolic systems*

## The Metabolic Metaphor

A context window is an organism with a fixed caloric budget. Every token consumed (prompt) or produced (completion) draws from the same finite energy pool. When the organism starves — context exhaustion — it doesn't degrade gracefully; it hallucinates, loops, or dies mid-sentence.

**The core insight:** Health isn't about absolute token counts. It's about *metabolic ratios* — what percentage of capacity remains available for productive work.

## Quantifiable Vitals

| Metric | Definition | Formula | Healthy Range |
|--------|-----------|---------|---------------|
| **Metabolic Load** | Prompt tokens as % of context window | `prompt_tokens / context_window` | < 70% |
| **Output Reserve** | Tokens available for completion | `context_window - prompt_tokens` | > 25% of window |
| **Pruning Delta (ΔP)** | Tokens reclaimed per pruning cycle | `pre_prune - post_prune` | 15–30% of window |
| **Burn Rate** | Token consumption per conversation turn | `Δprompt_tokens / turns` | Monitor for spikes |
| **Starvation Index** | How close to hard minimum | `remaining / hard_min` | > 2.0 |

**Rule of thumb:** If Metabolic Load exceeds 80%, the organism is in anaerobic crisis — pruning or session reset is mandatory.

## The Problem: Hardcoded Thresholds

Current `context-window-guard.ts`:

```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;  // block threshold
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000; // warn threshold
```

This is like prescribing the same blood pressure medication to a mouse and an elephant:

| Model | Context Window | Warn @ 32K | Block @ 16K | Problem |
|-------|---------------|------------|-------------|---------|
| GPT-4o-mini | 8K | 400% of window | 200% of window | **Both thresholds exceed total capacity** — guard never fires, or fires immediately |
| Claude Haiku | 32K | 100% of window | 50% of window | Warns when completely empty; blocks at half capacity |
| Claude Sonnet | 200K | 16% of window | 8% of window | Only 8% reserved at block — **92% consumed before any intervention** |
| Gemini 1.5 | 1M+ | 3.2% of window | 1.6% of window | Effectively no guard at all |

**Diagnosis:** Absolute thresholds create an inverse care law — small models get over-protected (or nonsensically guarded), large models get under-protected.

## The Fix: Percentage-Based Thresholds

Replace absolute constants with ratios of the model's actual context window:

```typescript
// Proposed: percentage-based defaults
export const CONTEXT_WINDOW_WARN_BELOW_RATIO = 0.25;  // warn at 25% remaining
export const CONTEXT_WINDOW_HARD_MIN_RATIO = 0.10;     // block at 10% remaining

export function evaluateContextWindowGuard(params) {
  const windowSize = params.contextWindowTokens;
  const warnBelow = params.warnBelowTokens
    ?? Math.max(1, Math.floor(windowSize * (params.warnBelowRatio ?? CONTEXT_WINDOW_WARN_BELOW_RATIO)));
  const hardMin = params.hardMinTokens
    ?? Math.max(1, Math.floor(windowSize * (params.hardMinRatio ?? CONTEXT_WINDOW_HARD_MIN_RATIO)));
  // ... shouldWarn: tokens < warnBelow, shouldBlock: tokens < hardMin
}
```

**Backward compatible:** Absolute overrides (`warnBelowTokens`, `hardMinTokens`) still take precedence when explicitly set.

## OpenClaw Configuration Examples

### Default (percentage-based, recommended)

```jsonc
// openclaw.json
{
  "contextWindowGuard": {
    "warnBelowRatio": 0.25,
    "hardMinRatio": 0.10
  }
}
```

Effect across models:

| Model (Window) | Warn Threshold | Block Threshold |
|----------------|---------------|-----------------|
| 8K model | 2,000 tokens | 800 tokens |
| 32K model | 8,000 tokens | 3,200 tokens |
| 128K model | 32,000 tokens | 12,800 tokens |
| 200K model | 50,000 tokens | 20,000 tokens |

### Aggressive (long autonomous sessions)

```jsonc
{
  "contextWindowGuard": {
    "warnBelowRatio": 0.35,
    "hardMinRatio": 0.15
  }
}
```

### Absolute override (legacy compatibility)

```jsonc
{
  "contextWindowGuard": {
    "warnBelowTokens": 32000,
    "hardMinTokens": 16000
  }
}
```

### Per-model tuning via model profiles

```jsonc
{
  "models": {
    "claude-sonnet": {
      "contextWindowGuard": { "warnBelowRatio": 0.20, "hardMinRatio": 0.08 }
    },
    "gpt-4o-mini": {
      "contextWindowGuard": { "warnBelowRatio": 0.30, "hardMinRatio": 0.15 }
    }
  }
}
```

## Metabolic Health Checklist

1. **Know your organism's size** — Verify `contextWindowTokens` is correctly reported per model
2. **Set ratios, not absolutes** — Unless you have a specific reason for fixed thresholds
3. **Monitor Pruning Delta** — If ΔP < 10% of window, pruning strategy is ineffective
4. **Watch Burn Rate trends** — Tool-heavy sessions burn faster (tool schemas are caloric bombs)
5. **Reserve Output Reserve** — Completion needs room; a 90%-full context produces truncated responses

## Research Context

- **Source code:** `context-window-guard.ts` in OpenClaw core — defines `CONTEXT_WINDOW_HARD_MIN_TOKENS` (16K) and `CONTEXT_WINDOW_WARN_BELOW_TOKENS` (32K) as compile-time constants
- **Core issue:** Absolute token thresholds are model-size-invariant, violating the principle that resource guards should scale with the resource they protect
- **Precedent:** Kubernetes resource limits use percentage-based eviction thresholds (`--eviction-hard=memory.available<10%`), not absolute byte counts — same reasoning applies
- **Related:** OpenClaw pruning pipeline, model registry (`contextWindow` field), session lifecycle management
- **Status:** Proposal stage — percentage-based guards with absolute fallback, backward-compatible with existing `warnBelowTokens`/`hardMinTokens` overrides
