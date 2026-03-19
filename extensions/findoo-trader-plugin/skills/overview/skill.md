---
name: fin-overview
description: "Portfolio overview, daily brief, risk status, and account summary. Use when: user asks about their overall financial status, account balance, daily brief, or risk level."
metadata: { "openclaw": { "emoji": "🏠", "requires": { "extensions": ["findoo-trader-plugin"] } } }
---

# Overview Skill

Provide a high-level summary of the user's financial status — account balances, risk level, and daily brief.

## When to Use

**USE this skill when:**

- "我的账户怎么样" / "account overview"
- "今日简报" / "daily brief"
- "风险状态" / "risk status"
- "账户余额" / "total equity"
- "总览" / "dashboard overview"
- "我的资产概况"

## When NOT to Use

**DON'T use this skill when:**

- User wants to place a trade -- use fin-trading
- User asks for a specific price or chart -- use fin-market-data
- User wants to create or backtest a strategy -- use strategy-builder
- User wants to configure exchanges or settings -- refer to /dashboard/setting

## Tools

### fin_paper_list

List all paper trading accounts with equity and cash balances.

```
fin_paper_list({})
```

### fin_paper_state

Get detailed state for a specific paper account (equity, cash, positions).

```
fin_paper_state({ accountId: "acct-1" })
```

### fin_paper_metrics

Get performance metrics (return, drawdown, Sharpe) for a paper account.

```
fin_paper_metrics({ accountId: "acct-1" })
```

### fin_fund_status

Get fund-level status including AUM, allocation, and risk level.

```
fin_fund_status({})
```

### fin_fund_risk

Get current risk assessment across the fund.

```
fin_fund_risk({})
```

## Dashboard

- Overview page: `/dashboard/overview` (or `/api/v1/finance/mission-control`)
- Daily brief API: `/api/v1/finance/daily-brief`
- Risk evaluation: `/api/v1/finance/risk/evaluate`

## Response Guidelines

- Start with total equity across all accounts.
- Include daily P&L and overall return when available.
- Highlight risk level (normal, elevated, critical) prominently.
- If daily brief is available, summarize key events and strategy performance.
- For empty accounts (no positions), suggest exploring strategies or market data.
