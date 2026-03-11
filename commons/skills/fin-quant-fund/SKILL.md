---
name: fin-quant-fund
description: "One-person quant fund management — fund status, capital allocation, rebalancing, strategy leaderboard, and risk monitoring."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏦",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# Quant Fund Manager

Manage a one-person professional quant fund. View fund status, allocate capital across strategies, rebalance portfolios, monitor risk levels, and track strategy rankings — all from a single dashboard.

## When to Use

**USE this skill when:**

- "show fund status" / "how's my fund doing"
- "rebalance my portfolio"
- "allocate capital" / "redistribute funds"
- "show strategy leaderboard" / "rank strategies"
- "what's my fund risk level"
- "how much is allocated to each strategy"
- "which strategies should I promote/demote"

## When NOT to Use

**DON'T use this skill when:**

- User wants to create/backtest a new strategy -- use fin-strategy-research
- User wants to review past trades -- use fin-trade-review
- User wants to evolve/mutate strategies -- use fin-strategy-evolution
- User wants current price or market data -- use fin-market-data
- User wants to execute a live trade -- use fin-trading

## Tools

### Fund Tools

- `fin_fund_status` -- View fund portfolio status
  - Returns: total capital, allocations, risk level, strategy distribution by level (L0-L3)

- `fin_fund_allocate` -- Compute Half-Kelly capital allocations
  - Returns: allocation per strategy, total allocated, cash reserve

- `fin_fund_rebalance` -- Execute full rebalance cycle
  - Steps: re-profile strategies, compute correlations, re-allocate capital, check promotions/demotions
  - Returns: allocations, leaderboard, risk status, promotion/demotion recommendations

- `fin_leaderboard` -- View strategy leaderboard
  - Parameters: `level` (optional: L1_BACKTEST, L2_PAPER, L3_LIVE)
  - Returns: ranked strategies with confidence-adjusted fitness scores

- `fin_fund_promote` -- Check promotion eligibility
  - Parameters: `strategyId`
  - Returns: eligibility status, reasons, blockers

- `fin_fund_risk` -- Evaluate fund-level risk
  - Returns: daily drawdown, exposure %, risk level, recommended actions

### Supporting Tools

- `fin_strategy_list` -- List all strategies and their levels
- `fin_paper_state` -- Paper trading account status
- `fin_data_regime` -- Current market regime

## Fund Management Framework

### Capital Allocation (Modified Half-Kelly)

- Single strategy cap: 30% of total capital
- Total exposure cap: 70% (30% minimum cash reserve)
- Highly correlated strategy group: 40% combined cap
- New L3 strategies: 10% cap for first 30 days
- L2 paper strategies: 15% cap
- Allocation proportional to fitness rank

### Risk Levels

| Level    | Trigger        | Action                        |
| -------- | -------------- | ----------------------------- |
| Normal   | No drawdown    | Normal operations             |
| Caution  | Daily DD > 3%  | Reduce new position sizes 20% |
| Warning  | Daily DD > 5%  | Shrink all positions 50%      |
| Critical | Daily DD > 10% | HALT all trading              |

### Strategy Lifecycle

```
L0 (Incubate) → L1 (Backtest) → L2 (Paper) → L3 (Live)
                                                    ↓ (demotion)
                                               L2 ← L3
```

## Response Guidelines

- Always show the fund summary table first (total equity, allocation count, risk level)
- Highlight any strategies due for promotion or demotion
- When showing leaderboard, include confidence multiplier explanation
- Flag any high-correlation pairs that need attention
- After rebalancing, show before/after allocation comparison

## Risk Disclosures

> Past performance does not guarantee future results. The allocation algorithm uses historical and simulated data. Always review recommendations before committing real capital. This is not financial advice.
