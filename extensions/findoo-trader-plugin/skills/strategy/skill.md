---
name: fin-strategy
description: "Strategy management — create, backtest, list, promote, and evolve trading strategies. Use when: user asks about strategies, backtesting, strategy rankings, or promotion pipeline."
metadata: { "openclaw": { "emoji": "🧪", "requires": { "extensions": ["findoo-trader-plugin"] } } }
---

# Strategy Skill

Create, backtest, rank, and promote trading strategies through the L0-L3 pipeline.

## When to Use

**USE this skill when:**

- "创建策略" / "create a strategy"
- "回测" / "backtest" / "回测过去30天"
- "策略列表" / "list strategies" / "策略排行"
- "晋升策略" / "promote strategy"
- "策略状态" / "strategy status"
- "模拟盘运行" / "paper trade this strategy"

## When NOT to Use

**DON'T use this skill when:**

- User wants to turn a natural language idea into a full FEP package -- use fin-strategy-builder
- User wants to place a live trade directly -- use fin-trading
- User asks about portfolio balances without strategy context -- use fin-portfolio
- User asks for market data or prices -- use fin-market-data

## Tools

### fin_strategy_create

Register a new strategy definition.

```
fin_strategy_create({
  name: "EMA Crossover",
  type: "trend-following",
  params: { fastPeriod: 12, slowPeriod: 26 }
})
```

### fin_strategy_list

List all registered strategies with their current level and performance.

```
fin_strategy_list({})
```

### fin_backtest_run

Run a backtest on a strategy with historical data.

```
fin_backtest_run({
  strategyId: "ema-crossover-001",
  symbol: "BTC/USDT",
  timeframe: "1d",
  startDate: "2025-01-01",
  endDate: "2025-12-31"
})
```

### fin_backtest_result

Get the result of a completed backtest.

```
fin_backtest_result({ strategyId: "ema-crossover-001" })
```

### fin_strategy_tick

Manually trigger a strategy tick (execute one cycle).

```
fin_strategy_tick({ strategyId: "ema-crossover-001" })
```

### fin_fund_promote

Promote a strategy to the next level (L0 -> L1 -> L2 -> L3).

```
fin_fund_promote({ strategyId: "ema-crossover-001" })
```

### fin_leaderboard

View strategy rankings by performance.

```
fin_leaderboard({})
```

## Dashboard

- Strategy page: `/dashboard/strategy`
- Strategy API: `/api/v1/finance/strategies`
- Backtest progress SSE: `/api/v1/finance/backtest/progress/stream`
- Strategy SSE: `/api/v1/finance/strategy/stream`

## Promotion Pipeline

| Level | Stage    | Requirements                             |
| ----- | -------- | ---------------------------------------- |
| L0    | Incubate | Strategy created, parameters defined     |
| L1    | Backtest | Passed backtest with positive return     |
| L2    | Paper    | Running on paper account with live data  |
| L3    | Live     | User-confirmed promotion to real capital |

## Response Guidelines

- When listing strategies, show level, return, and Sharpe ratio.
- For backtest results, highlight total return, max drawdown, win rate, and Sharpe.
- Before promoting to L3 (live), always confirm with the user.
- Show backtest progress percentage for long-running backtests.
