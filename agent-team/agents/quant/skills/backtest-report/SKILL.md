---
name: backtest_report
description: Run a backtest with explicit assumptions and save the full artifact as JSON, then post a short pointer to #quant-signals. Trigger on any Orchestrator dispatch asking to test a strategy on historical data.
---

# Backtest Report

Backtests live as JSON artifacts. Slack gets a one-line headline + pointer. Orchestrator pulls the full file via A2A.

## Trigger

Orchestrator dispatched a backtest request, or a thesis from `#research` needs historical stress before it becomes decision-grade.

## Inputs

- Strategy rules (entry, exit, stops, sizing) in full.
- Universe (ticker list or index).
- Data window (start date, end date) using adjusted close unless otherwise specified.
- In-sample / out-of-sample split.
- Data source (Yahoo, Polygon, Tiingo, etc.) — must be real market data, never fabricated.

## Steps

1. Restate the strategy rules unambiguously. If any rule is ambiguous, stop and ask in `#dispatch` via `@Orchestrator - Portfolio Manager`. Do not guess.
2. Load data from the declared source. If the feed is unavailable, report the failure in `#quant-signals` and stop — never fabricate.
3. Compute in-sample and out-of-sample runs separately. Record: Sharpe, max drawdown, win rate, max consecutive losses, CAGR, turnover, cost assumptions.
4. Save the full artifact as `files/YYYY-MM-DD/quant-backtest-<slug>.json` via `file_layout_discipline`. Include raw equity curve, per-trade log, parameters, data hash, and caveats in the JSON.
5. Compose a short pointer for `#quant-signals` using the format below.
6. Decorate source/metrics with `source_and_confidence`.
7. Decide tagging: tag `@Orchestrator - Portfolio Manager` only if the result is outside normal range or contradicts a prior thesis. Otherwise stop — Orchestrator reads the channel.

## Pointer format (the Slack post)

```
[backtest] <strategy slug>  OOS Sharpe <n>  MaxDD <n%>
Window: <start>..<end>  IS/OOS split: <date>
File: files/YYYY-MM-DD/quant-backtest-<slug>.json
Caveats: <one line, e.g. "wide parameter sweep → overfit risk">
Confidence: <High|Medium|Low>
```

## Required sections in the JSON artifact

- `strategy_rules` — full, unambiguous
- `universe`
- `data_source`, `data_window`, `data_hash`
- `is_metrics`, `oos_metrics` (Sharpe, MaxDD, CAGR, win rate, max consec losses, turnover)
- `equity_curve` (dates + values)
- `trades` (entry/exit/pnl per trade)
- `assumptions` (slippage, commissions, borrow, dividends)
- `caveats` (overfit risk, regime dependence, survivorship, data limitations)

## Rules

- Never describe a backtest result as a prediction.
- Never do prose-only arithmetic. Every number must come from the computation.
- Flag overfitting risk whenever parameter search was wide.
- Use adjusted close for total-return backtests unless explicitly told otherwise.
- If in-sample and out-of-sample diverge materially, say so plainly in the caveats.

## Where to post

`#quant-signals` only. The file lives in your workspace; other agents pull via A2A.

## Next step

Append the row to `files/index.md`. If Devil's Advocate asks a follow-up in `#quant-signals`, answer in-channel with evidence from the JSON. If Orchestrator pulls the artifact via A2A, no action needed — that's the designed path.
