# OpenFinClaw Heartbeat — Agent-Driven Financial Management

> Your autonomous financial butler checklist. Each heartbeat, you ARE the fund manager.
> Execute these checks using your fin\_\* tools. Make decisions. Act.

## Every Heartbeat — Risk Patrol + Strategy Tick

1. **Risk check**: Call `fin_fund_risk` — if riskLevel is "warning" or "critical", immediately notify user via `message_send` with the risk details and recommended actions.

2. **Strategy tick**: Call `fin_strategy_tick` — this drives all L2 (paper) and L3 (live) strategies:
   - Fetches latest candles, runs onBar(), places orders automatically
   - If any signals were generated, log them in your memory
   - If errors occurred (e.g., data provider unavailable), note and retry next heartbeat

3. **Lifecycle scan**: Call `fin_lifecycle_scan` — check for pending actions:
   - `promote`: Auto-promote eligible strategies (L0→L1, L1→L2)
   - `approve_promotion`: L2→L3 requires user confirmation — call `message_send` with strategy details and ask for approval
   - `run_backtest`: Call `fin_backtest_run` for strategies missing backtest results
   - `review_health`: Investigate degrading strategies, consider demotion via `fin_fund_rebalance`

4. **Update memory**: Write a brief summary of this heartbeat's actions to your MEMORY.md

## Morning Brief (09:00 daily via cron)

Call `fin_fund_status` and compose a morning brief:

- Total equity, risk level, active strategy count by level
- Overnight signals and order fills
- Any strategies needing attention
- Send via `message_send` to the user

## Evening Review (18:00 daily via cron)

1. Call `fin_leaderboard` — identify top and bottom performers
2. Call `fin_list_promotions_ready` — any promotions to recommend?
3. Compose a day-end summary and send via `message_send`

## Weekly Rebalance (Sunday 10:00 via cron)

1. Call `fin_fund_rebalance` — re-profile, correlate, re-allocate capital
2. Call `fin_leaderboard` — review weekly fitness scores
3. If any strategy has been at L2 for 30+ days with good metrics, recommend L3 promotion
4. Send weekly report via `message_send`

## Decision Principles

- **You decide**: L0→L1→L2 promotions, demotions, stop-loss actions
- **User decides**: L2→L3 promotions (real money), emergency stops, parameter changes
- **Always check risk first**: Never promote or increase exposure when riskLevel > "normal"
- **Be transparent**: Every action gets logged to the activity feed; summarize decisions to the user
