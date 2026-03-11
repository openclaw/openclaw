---
name: fin-strategy-research
description: "Research and create trading strategies — analyze market regimes, design candidates, backtest with Walk-Forward validation, and deploy to paper trading."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔬",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# Strategy Research Lab

Research, design, and validate trading strategies. Analyze market regimes, generate candidate strategies, run backtests with mandatory Walk-Forward validation, and deploy winners to paper trading.

## When to Use

**USE this skill when:**

- "research a BTC trend strategy" / "help me find a good strategy"
- "design a mean reversion strategy for ETH"
- "what strategies work in the current market"
- "create a strategy for sideways markets"
- "run a full strategy pipeline from research to paper"
- "which regime is BTC in right now"

## When NOT to Use

**DON'T use this skill when:**

- User wants fund-level management -- use fin-quant-fund
- User wants to review past trades -- use fin-trade-review
- User wants to evolve existing strategies -- use fin-strategy-evolution
- User wants a simple one-off backtest -- use fin-backtest
- User wants to execute a live trade -- use fin-trading

## Tools

### Research Pipeline Tools

- `fin_data_regime` -- Analyze current market regime
  - Parameters: `symbol`, `market`
  - Returns: regime classification (bull/bear/sideways/volatile/crisis)

- `fin_data_ohlcv` -- Fetch historical OHLCV data
  - Parameters: `symbol`, `market`, `timeframe`, `since`, `limit`

- `fin_strategy_create` -- Register a new strategy
  - Parameters: `name`, `type`, `parameters`, `symbols`, `timeframes`

- `fin_backtest_run` -- Execute backtest with Walk-Forward
  - Parameters: `strategyId`, `startDate`, `endDate`, `capital`, `options`

- `fin_backtest_result` -- Query backtest results
  - Parameters: `backtestId`

- `fin_paper_deploy` / `fin_paper_create` -- Deploy to paper trading
  - Parameters: `capital`, `currency`, `strategies`

## Research Methodology

When the user asks to research a strategy, follow this pipeline:

### Step 1: Market Analysis

1. Call `fin_data_regime` to analyze the target market's current and historical regime
2. Identify which regime types dominate (bull, bear, sideways, volatile)
3. Note any regime transitions that could affect strategy selection

### Step 2: Candidate Design

Based on regime analysis and the user's preferences, design 2-3 candidate strategies:

| Regime   | Recommended Types                             |
| -------- | --------------------------------------------- |
| Bull     | Trend following (SMA crossover, momentum)     |
| Bear     | Short-biased mean reversion, hedged           |
| Sideways | Mean reversion (RSI, Bollinger), grid trading |
| Volatile | Momentum with tight stops, breakout           |
| Crisis   | Cash-heavy, inverse correlation, hedging      |

### Step 3: Backtest with Walk-Forward (Mandatory)

For each candidate:

1. Call `fin_strategy_create` to register the strategy
2. Call `fin_backtest_run` with Walk-Forward validation enabled
3. Walk-Forward settings: 4-5 windows, 70% train / 30% test
4. Pass condition: test Sharpe ≥ train Sharpe × 0.6

### Step 4: Evaluate Results

Check L2 promotion thresholds:

- Walk-Forward passed
- Sharpe ratio ≥ 1.0
- Max drawdown ≤ 25%
- At least 100 trades
- Survived 3+ regime types

### Step 5: Deploy Winner

If a strategy meets thresholds:

1. Call `fin_paper_create` to deploy to paper trading
2. Inform user: "Strategy deployed to paper trading. After 30 days of successful simulation, it will be eligible for live promotion."

## Response Guidelines

- Present regime analysis first with clear classification
- Show candidates in a comparison table (strategy type, expected behavior, risk profile)
- After backtesting, show side-by-side metrics (Sharpe, DD, win rate, profit factor)
- Clearly mark Walk-Forward pass/fail for each candidate
- Explain WHY the winning strategy was selected
- Always end with next steps (paper trading timeline, monitoring plan)

## Risk Disclosures

> Backtested results are hypothetical and subject to overfitting. Walk-Forward validation reduces but does not eliminate this risk. Paper trading provides forward validation before committing real capital.
