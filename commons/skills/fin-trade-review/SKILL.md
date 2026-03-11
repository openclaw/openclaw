---
name: fin-trade-review
description: "Trade review and learning — replay trades, analyze mistakes via error book, track success patterns, and generate experience insights."
metadata: { "openclaw": { "emoji": "📓", "requires": { "extensions": ["findoo-trader-plugin"] } } }
---

# Trade Review & Learning

Review past trades, identify mistake patterns through the error book, track success patterns, and extract actionable experience insights. Turns every trade into a learning opportunity.

## When to Use

**USE this skill when:**

- "review today's trades" / "how did I do today"
- "show my error book" / "what mistakes do I keep making"
- "what are my success patterns"
- "review trades for the past week"
- "what should I avoid doing"
- "show trading insights" / "lessons learned"
- "replay my BTC trades"

## When NOT to Use

**DON'T use this skill when:**

- User wants to create or backtest a strategy -- use fin-strategy-research or fin-backtest
- User wants to manage fund allocations -- use fin-quant-fund
- User wants to execute a trade -- use fin-trading
- User wants current market data -- use fin-market-data

## Tools

### Review Tools

- `fin_review_trades` -- Review trades for a period
  - Parameters: `period` (1d, 7d, 30d, all), `strategyId` (optional), `symbol` (optional)
  - Returns: trade list with P&L, win/loss breakdown, key patterns

- `fin_error_book_query` -- Query error book for mistake patterns
  - Parameters: `category` (optional), `symbol` (optional), `severity` (optional)
  - Returns: matched error patterns with frequency, impact, and recommendations

- `fin_success_book_query` -- Query success patterns
  - Parameters: `category` (optional), `symbol` (optional)
  - Returns: matched success patterns with frequency and conditions

- `fin_experience_summary` -- Get consolidated experience insights
  - Returns: top errors, top successes, regime-specific lessons, overall improvement trend

## Review Framework

### Daily Review Checklist

1. **Trade Replay**: Walk through each trade chronologically
   - Entry reason, timing, sizing
   - Exit reason and outcome
   - Was the entry/exit aligned with strategy rules?

2. **Pattern Detection**:
   - Repeated mistakes (same error pattern, same conditions)
   - New error patterns to log
   - Success patterns to reinforce

3. **Quantitative Summary**:
   - Win rate, average win/loss ratio
   - Largest win and largest loss
   - Strategy adherence score

### Error Book Categories

| Category   | Examples                                          |
| ---------- | ------------------------------------------------- |
| Timing     | Chasing pumps, selling too early, ignoring regime |
| Sizing     | Overleveraged, position too large for volatility  |
| Discipline | Ignored stop-loss, FOMO entry, revenge trading    |
| Analysis   | Misread regime, wrong indicator interpretation    |
| Execution  | Slippage underestimated, wrong order type         |

### Experience Extraction

After each review, the system:

1. Identifies recurring patterns (3+ occurrences)
2. Assigns severity based on P&L impact
3. Generates constraint rules (e.g., "RSI > 80: do not open new long")
4. Syncs insights to memory for future context injection

## Response Guidelines

- Start with a high-level P&L summary (win/loss count, net P&L)
- Walk through trades chronologically with clear entry/exit annotations
- Highlight mistakes with specific actionable corrections
- End with 3 key takeaways and a commitment for the next session
- Use tables for trade summaries and error book queries
- Be constructive — frame errors as learning opportunities, not failures

## Risk Disclosures

> Trade reviews analyze past performance only. Identified patterns may not repeat in different market conditions. Error book constraints are suggestions, not guarantees of better future performance.
