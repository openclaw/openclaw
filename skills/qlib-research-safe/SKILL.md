---
name: qlib-research-safe
description: Generate bounded, leak-safe alpha signals from local market data using a Qlib-style research layer. Use for feature research and signal export only (no execution).
---

# qlib-research-safe

Use this skill for the **research layer** only.

## Rules

- Paper/research only.
- Use local CSV data unless user explicitly approves remote fetch.
- Output bounded `alpha_score` in `[-1, 1]` and `confidence` in `[0, 1]`.
- No trading execution from this skill.

## Standard run

- `python3 /home/node/.openclaw/workspace/skills/trading-trinity-safe/scripts/run_trinity_backtest.py --csv <csv> --symbol <symbol> --out-dir <dir>`
- Read `signals.csv` from the generated artifacts as research output.

