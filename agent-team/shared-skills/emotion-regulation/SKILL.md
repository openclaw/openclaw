---
name: emotion_regulation
description: Apply calibration rules during volatility spikes, panic windows, or any session where Quant has flagged abnormal conditions. Trigger when about to post at High confidence during abnormal volatility, or when multiple signals move together, or during a red-day panic window.
---

# Emotion Regulation

The market moves fast. Calibration is fragile. This skill is a short checklist that slows you down just before a high-confidence post when conditions are abnormal. Rob's ask: keep the team from overreacting to short-term moves.

## Trigger

Any of:
- You are about to post at **High** confidence during a session Quant has flagged with abnormal volatility (VIX spike, sector dispersion, or a `[tech-signals]` post listing extremes).
- Multiple independent signals are moving together (e.g., CPI surprise + mega-cap earnings miss + equity selloff simultaneously).
- A position has moved ≥ 8% intraday and you feel the urge to publish a thesis revision inside the same session.
- Pre-FOMC or pre-CPI windows (volatility typically elevated).

## Inputs

- Your draft post.
- Current volatility flags from Quant (`compute_technical_signals`, `backtest_report`).
- Your own `MEMORY.md` entries from the past week.

## Steps

1. **Slow down.** Do not send the draft yet.
2. **Volatility is not signal.** A single large move, by itself, is not a thesis. Name what structural change it represents — if you cannot, the move alone is not enough.
3. **Re-read your own MEMORY.md entries from the past week.** Look for notes that say "don't overreact on…" or "kill condition not tripped until…" If past-you already addressed this, defer to past-you.
4. **Increase skepticism by one notch.** Drop the draft's confidence label one level: High → Medium, Medium → Low. If you still believe the original label, justify it inline.
5. **Check for team confirmation before escalation.** If your draft contradicts a recent Devil's Advocate review, do not override it alone — reply in `#contrarian` and surface the conflict.
6. **Never publish a thesis revision the same session a position moved ≥ 8% intraday** unless Devil's Advocate also signs off.
7. Now decide: post (with the lowered confidence) or wait.

## Rules

- Volatility is not signal.
- A single 8% move is not a thesis.
- Slow down before posting.
- Increase skepticism by one notch when multiple signals move together.
- Never override a recent Devil's Advocate verdict alone during a volatility window.

## Output format

This skill decorates the draft — it either lowers confidence, forces a wait, or blocks the post. It does not change destinations.

## Where to post

Wherever you were already going to post, once the calibration check passes.

## Next step

Append a one-line note to your `MEMORY.md` at session end: what you almost posted, what the calibration check changed, and whether the market proved the adjustment right.
