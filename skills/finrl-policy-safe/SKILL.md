---
name: finrl-policy-safe
description: Apply a FinRL-style risk-aware policy layer that maps alpha signals to capped target exposure with volatility and drawdown throttles. Paper mode only.
---

# finrl-policy-safe

Use this skill for the **policy layer** only.

## Rules

- Paper mode only.
- Enforce position/turnover/drawdown/volatility constraints.
- Do not place live orders.

## Standard run

- `python3 /home/node/.openclaw/workspace/skills/trading-trinity-safe/scripts/run_trinity_backtest.py --csv <csv> --symbol <symbol> --out-dir <dir>`
- Use `signals.csv` fields `target_position`, `filled_position`, and `flags` as policy output.

