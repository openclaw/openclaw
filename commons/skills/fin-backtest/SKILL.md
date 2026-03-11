---
name: fin-backtest
status: draft
description: "Strategy backtesting engine - test trading strategies against historical data, compute performance metrics, optimize parameters, and run Monte Carlo simulations."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧪",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# Strategy Backtester

Test trading strategies against historical data with institutional-grade metrics. Supports 8 built-in strategies, natural language strategy definition, parameter optimization, and Monte Carlo simulation.

## When to Use

**USE this skill when:**

- "backtest SMA crossover on BTC" / "test this strategy"
- "how would buy and hold have performed"
- "compare DCA vs lump sum historically"
- "optimize RSI parameters for ETH"
- "what's the win rate of this approach"
- "Monte Carlo simulation" / "probability of ruin"
- "buy when RSI < 30, sell when RSI > 70" (natural language strategy)
- "Sharpe ratio of momentum strategy on SOL"

## When NOT to Use

**DON'T use this skill when:**

- User wants to execute a live trade -- use fin-trading
- User wants current portfolio analysis -- use fin-portfolio
- User wants forward-looking analysis or predictions -- use fin-expert
- User wants to set up recurring DCA -- use fin-dca-strategy
- User wants risk metrics on current holdings -- use fin-risk-manager

## Tools

### Existing Tools

- `fin_market_price` -- fetch historical OHLCV data for backtesting (required for all strategies)

### Backtest-Specific Tools (Documented)

- `fin_backtest_run` -- execute a backtest
  - Parameters: `asset`, `strategy` (buy_and_hold | dca_periodic | sma_crossover | rsi_mean_reversion | bollinger_breakout | macd_signal | momentum | custom), `params` (strategy-specific), `start_date`, `end_date`, `initial_capital`, `fees_pct` (default 0.1%), `slippage_pct` (default 0.05%)
  - Returns: equity curve, trade list, performance metrics, drawdown series

- `fin_backtest_compare` -- compare multiple strategies side-by-side
  - Parameters: `backtests[]` (array of backtest configs), `benchmark` (buy_and_hold by default)
  - Returns: comparison table of all metrics, relative performance chart

- `fin_backtest_optimize` -- grid search for optimal parameters
  - Parameters: `asset`, `strategy`, `param_ranges` (min/max/step for each parameter), `start_date`, `end_date`, `optimization_target` (sharpe | sortino | total_return | calmar), `train_split` (default 0.7)
  - Returns: best parameters, in-sample vs out-of-sample metrics, overfit warning flag

## Built-in Strategies

### 1. Buy and Hold

Baseline benchmark. Buy at start, hold until end.

- Parameters: none
- Use case: benchmark comparison for all other strategies

### 2. DCA Periodic

Dollar-cost average at fixed intervals.

- Parameters: `frequency` (daily | weekly | biweekly | monthly), `amount_per_period`
- Use case: compare DCA vs lump sum entry

### 3. SMA Crossover

Buy when fast SMA crosses above slow SMA, sell on cross below.

- Parameters: `fast_period` (default 10), `slow_period` (default 30)
- Use case: trend following

### 4. RSI Mean Reversion

Buy when RSI drops below oversold threshold, sell when above overbought.

- Parameters: `period` (default 14), `oversold` (default 30), `overbought` (default 70)
- Use case: range-bound markets, mean reversion

### 5. Bollinger Breakout

Buy on close above upper band, sell on close below lower band.

- Parameters: `period` (default 20), `std_dev` (default 2.0)
- Use case: volatility breakout capture

### 6. MACD Signal

Buy on MACD crossing above signal line, sell on cross below.

- Parameters: `fast_ema` (default 12), `slow_ema` (default 26), `signal_period` (default 9)
- Use case: momentum trend following

### 7. Momentum

Buy top N assets by trailing return, rebalance periodically.

- Parameters: `lookback_days` (default 30), `rebalance_frequency` (weekly | monthly), `top_n` (default 3)
- Use case: cross-asset momentum rotation

### 8. Custom (Natural Language)

AI interprets natural language strategy descriptions into structured rules.

- Parameters: `description` (natural language, e.g., "buy when RSI < 25 and volume is above 20-day average, sell after 10% gain or 5% stop loss")
- The AI parses the description into entry conditions, exit conditions, and position sizing rules.
- Always echo back the interpreted rules for user confirmation before running.

## Engine Pipeline

### Execution Order

1. **Data Preparation**: Fetch OHLCV data, validate completeness, handle gaps
2. **Indicator Calculation**: Compute all required technical indicators for the strategy
3. **Signal Generation**: Apply strategy rules to generate buy/sell signals
4. **Position Simulation**: Execute signals with realistic fills, fees, and slippage
5. **Performance Metrics**: Calculate comprehensive performance statistics

### Realistic Execution Model

- **Fees**: Default 0.1% per trade (configurable). Applied to both entries and exits.
- **Slippage**: Default 0.05% per trade. Simulates market impact.
- **Fill Price**: Next-bar open after signal (no look-ahead bias).
- **Position Sizing**: Full capital per trade unless otherwise specified.

## Performance Metrics

Every backtest produces these metrics:

| Metric             | Description                              |
| ------------------ | ---------------------------------------- |
| Total Return       | End-to-end percentage gain/loss          |
| CAGR               | Compound Annual Growth Rate              |
| Sharpe Ratio       | Risk-adjusted return (annualized)        |
| Sortino Ratio      | Downside-risk-adjusted return            |
| Max Drawdown       | Largest peak-to-trough decline           |
| Win Rate           | Percentage of profitable trades          |
| Profit Factor      | Gross profits / gross losses             |
| Avg Win / Avg Loss | Mean winning vs losing trade size        |
| Exposure Time      | Percentage of time with an open position |
| Trade Count        | Total number of round-trip trades        |

## Parameter Optimization

### Grid Search with Overfitting Protection

1. Split data into 70% train / 30% out-of-sample (OOS) by default.
2. Run grid search over parameter ranges on the training set.
3. Select best parameters by optimization target (Sharpe by default).
4. Evaluate best parameters on OOS data.
5. **Overfit Warning**: Flag if OOS performance degrades >50% vs in-sample. Present both results transparently.

### Monte Carlo Simulation

After a backtest, optionally run Monte Carlo analysis:

1. Take the sequence of individual trade returns from the backtest.
2. Shuffle the order randomly 1,000 times.
3. For each shuffle, compute the equity curve and key metrics.
4. Report: median outcome, 5th percentile (worst case), 95th percentile (best case).
5. Calculate probability of ruin (equity dropping below a configurable threshold, default 50% of initial capital).

## Response Guidelines

- Always show a comparison against buy-and-hold as the baseline benchmark.
- Present metrics in a clean summary table -- start with Total Return, Sharpe, and Max Drawdown.
- When comparing strategies, rank by Sharpe ratio (risk-adjusted) rather than raw return.
- For custom NL strategies, always echo back the interpreted rules and ask for confirmation.
- When optimizing, prominently display both in-sample and out-of-sample results. Warn explicitly about overfitting.
- Include the trade count -- strategies with very few trades have less statistical significance.
- Show the equity curve inflection points: when did the strategy perform best/worst and why?
- Suggest improvements: "This strategy underperforms in trending markets. Consider adding a trend filter."

## Risk Disclosures

- Backtesting uses historical data. Past performance does not predict future results.
- All backtests suffer from survivorship bias and may not reflect real execution conditions (liquidity, exchange outages, extreme volatility).
- Transaction costs and slippage in backtests are estimates. Real trading costs may vary significantly.
- Optimized parameters are fit to historical data. Out-of-sample degradation is expected. Never deploy a strategy without OOS validation.
- Monte Carlo simulation assumes trade independence. In reality, consecutive trades may be correlated.
