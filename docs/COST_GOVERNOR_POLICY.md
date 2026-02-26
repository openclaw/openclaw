# Cost Governor Policy (Free-first with approved paid escalation)

This policy enforces:

1. Free/default mode by default.
2. Paid escalation requires explicit operator approval with estimated incremental cost and cap.
3. De-escalation to free mode does not require approval.
4. If de-escalation quality loss is severe, ask approval before re-escalating.

## Scripted controller

Use `/Users/Dave/Documents/reaction_engine_with_decoder_layer_fix4/_references/openclaw/scripts/openclaw_cost_governor.sh`.

### Commands

- `status`
- `mode free|hybrid|burst [--yes]`
- `escalate --reason "<text>" --est-usd <amount> --cap-usd <amount> [--mode burst|hybrid] [--yes]`
- `deescalate [--yes]`
- `quality-check --free-score <0..1> --paid-score <0..1> [--threshold 0.20] [--yes]`

## Mode definitions

- `free`:
  - Local model first (`ollama/qwen2.5-coder:7b`)
  - Brave search rail
  - Perplexity search config removed
  - Tight web timeouts/caching
- `hybrid`:
  - Free-first behavior with slightly broader search envelope
- `burst`:
  - Paid search rail (`perplexity` via OpenRouter base URL)
  - Intended for approval-gated escalation windows

## Operator workflow

1. Keep default in `free`.
2. When quality/coverage/freshness is insufficient, estimate incremental cost and run `escalate`.
3. After task, run `deescalate` (or switch to `free`).
4. If free quality drops sharply, run `quality-check` to enforce approval before returning to paid mode.
