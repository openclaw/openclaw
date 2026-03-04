# OpenFinClaw Heartbeat — Financial Monitoring Checklist

> This template defines the periodic checks your financial butler performs.
> Customize frequencies and thresholds in your `openfinclaw.yaml` config.

## Every 30 Seconds — Critical Monitors

- [ ] **Stop-loss proximity**: Any position within 2% of stop-loss price?
- [ ] **Liquidation risk**: Any leveraged position above 80% margin usage?
- [ ] **Open order status**: Any orders stuck or partially filled beyond timeout?

## Every 5 Minutes — Price Alerts & KOL Urgent

- [ ] **User-defined price alerts**: Check all active alerts against current prices
- [ ] **Significant moves**: Any watched asset moved >3% in the last 5 minutes?
- [ ] **Spread anomalies**: Unusual bid-ask spreads on actively traded pairs?
- [ ] **KOL urgent check** (grok): Call `fin_info_digest period=urgent` — if items returned, push immediately to user

## Every Hour — Market Scan

- [ ] **Portfolio P&L update**: Calculate unrealized P&L across all exchanges
- [ ] **Correlation check**: Are portfolio assets moving in unexpected correlation?
- [ ] **Volume anomalies**: Unusual volume spikes on held assets?
- [ ] **Funding rates**: Check perpetual funding rates for held positions

## Daily at 07:00 — Morning Brief

- [ ] **Overnight summary**: What happened while you were away?
- [ ] **Portfolio snapshot**: Current holdings, P&L, allocation percentages
- [ ] **Market overview**: Major index moves, crypto market cap, fear/greed index
- [ ] **Calendar events**: Earnings, FOMC, token unlocks, options expiry today
- [ ] **Pending actions**: Unfilled orders, expiring alerts, due rebalances
- [ ] **KOL morning brief** (grok): Call `fin_info_digest period=morning` — overnight KOL intelligence summary
- [ ] **Fund status** (quant): Call `fin_fund_status` — total equity, risk level, active strategies
- [ ] **Regime check** (quant): Call `fin_data_regime` for each active market — detect regime changes
- [ ] **Decay scan** (quant): Check paper/live strategies for degrading or critical decay levels
- [ ] **Strategy lifecycle** (quant): Call `fin_list_promotions_ready` — promote L0→L1 strategies, run `fin_backtest_run` for L1 strategies missing backtest results, check L1→L2 eligibility

## Daily at 17:00 — End of Day Review

- [ ] **Day's trades**: Summary of all executed trades with P&L
- [ ] **Portfolio drift**: Has allocation drifted from target? Suggest rebalance?
- [ ] **Risk assessment**: Updated risk metrics (VaR, max drawdown, Sharpe)
- [ ] **News impact**: Key news events and their observed portfolio impact
- [ ] **KOL evening review** (grok): Call `fin_info_digest period=evening` — day's KOL intelligence recap with stats
- [ ] **Trade review** (quant): Call `fin_review_trades` — update error/success books
- [ ] **Promotion check** (quant): Any L2 strategies ready for L3 promotion?

## Weekly (Sunday 10:00) — Weekly Report

- [ ] **Weekly P&L**: Detailed breakdown by asset and strategy
- [ ] **Benchmark comparison**: Performance vs. BTC, ETH, S&P 500
- [ ] **Trade review**: Win rate, average R:R, best/worst trades
- [ ] **Strategy assessment**: Are current strategies performing as expected?
- [ ] **Rebalance recommendation**: Suggested portfolio adjustments
- [ ] **Upcoming week**: Key events and potential trading opportunities
- [ ] **Fund rebalance** (quant): Call `fin_fund_rebalance` — re-profile, correlate, re-allocate
- [ ] **Correlation matrix** (quant): Recalculate strategy correlations, flag high-corr pairs
- [ ] **Weekly review** (quant): Call `fin_review_trades period=7d` — weekly error/success summary

## Monthly (1st, 09:00) — Monthly Report

- [ ] **Monthly performance**: Returns, fees, slippage analysis
- [ ] **Asset allocation evolution**: How has the portfolio changed?
- [ ] **Tax events**: Capital gains/losses for tax reporting
- [ ] **Goal progress**: Are financial goals on track?
- [ ] **Risk profile review**: Should risk parameters be adjusted?
- [ ] **Evolution cycle** (quant): Call `fin_fund_rebalance` — full evolution: score, cull bottom 20%, mutate, re-backtest
- [ ] **Capital reallocation** (quant): Call `fin_fund_allocate` — redistribute based on updated fitness
- [ ] **Monthly report** (quant): Generate quant fund monthly report with leaderboard, promotions, kills
