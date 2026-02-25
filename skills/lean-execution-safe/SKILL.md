---
name: lean-execution-safe
description: Simulate LEAN-style execution with deterministic fills, fee/slippage modeling, turnover limits, and auditable trade logs. Paper/backtest only.
---

# lean-execution-safe

Use this skill for the **execution simulation layer** only.

## Rules

- Never execute live trades in this skill.
- Keep transaction cost and turnover caps enabled.
- Emit trade and equity artifacts every run.

## Standard run

- `python3 /home/node/.openclaw/workspace/skills/trading-trinity-safe/scripts/run_trinity_backtest.py --csv <csv> --symbol <symbol> --out-dir <dir>`
- Execution artifacts:
  - `trades.csv`
  - `equity.csv`
  - `metrics.json`

