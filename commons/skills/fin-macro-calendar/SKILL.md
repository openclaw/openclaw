---
name: fin-macro-calendar
status: draft
description: "Macroeconomic calendar and regime analysis - economic event tracking, earnings dates, macro regime classification, cross-market impact cascades, and portfolio event exposure."
metadata:
  {
    "openclaw":
      {
        "emoji": "🗓",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# Macro Calendar & Regime Analyst

Economic calendar tracking, earnings dates, macro regime classification using the Ray Dalio framework, event impact analysis, and portfolio-aware event exposure mapping.

## When to Use

**USE this skill when:**

- "what's on the economic calendar this week"
- "when is the next Fed meeting" / "FOMC schedule"
- "macro regime" / "are we in stagflation"
- "how will CPI affect my portfolio"
- "earnings calendar" / "when does AAPL report"
- "what's the current macro environment"
- "yield curve" / "is the curve inverted"
- "cross-market impact of rate hikes"

## When NOT to Use

**DON'T use this skill when:**

- User wants asset-specific technical analysis -- use fin-expert
- User wants on-chain blockchain metrics -- use fin-onchain
- User wants to execute a trade -- use fin-trading
- User wants news headlines or sentiment -- use fin-news-intel
- User wants to backtest a strategy -- use fin-backtest

## Tools

### Existing Tools

- `fin_market_price` -- price data for cross-asset impact analysis
- `fin_market_overview` -- broad market snapshot for regime context
- `fin_info_search` -- search for macro event analysis and commentary
- `fin_info_digest` -- digest of macro-relevant news
- `fin_portfolio_positions` -- user holdings for event exposure mapping

### Macro-Specific Tools (Documented)

- `fin_econ_calendar` -- upcoming economic data releases
  - Parameters: `timeframe` (today | this_week | next_week | this_month), `importance` (high | medium | all), `country` (US | EU | CN | JP | GB | all)
  - Returns: event list with date, time, name, previous value, consensus forecast, importance rating

- `fin_earnings_calendar` -- upcoming earnings reports
  - Parameters: `timeframe` (today | this_week | next_week), `sector` (optional filter), `watchlist_only` (boolean, filter to user's holdings)
  - Returns: company, report date, time (pre/post market), consensus EPS, consensus revenue, surprise history

- `fin_macro_regime` -- classify current macro regime
  - Parameters: `indicators[]` (optional override; default uses all available)
  - Returns: current regime classification, confidence level, key indicator readings, regime history (last 4 quarters)

- `fin_event_impact` -- analyze specific event's market impact
  - Parameters: `event_type` (fomc | cpi | nfp | gdp | pmi | earnings), `scenario` (hawkish | dovish | hot | cool | beat | miss | inline)
  - Returns: historical average impact by asset class, typical duration, reversal probability, cross-market cascade

## Macro Regime Classification

### Ray Dalio Framework

Classify the current macroeconomic environment into one of four regimes:

| Regime          | Growth  | Inflation | Favored Assets                        | Hurt Assets                   |
| --------------- | ------- | --------- | ------------------------------------- | ----------------------------- |
| **Goldilocks**  | Rising  | Falling   | Equities, Growth Tech, Crypto         | Gold, Commodities             |
| **Reflation**   | Rising  | Rising    | Commodities, Value, TIPS, Real Assets | Long Bonds, Growth Tech       |
| **Stagflation** | Falling | Rising    | Gold, Cash, Commodities, Short Vol    | Equities, Bonds, Crypto       |
| **Deflation**   | Falling | Falling   | Long Bonds, Cash, Quality             | Equities, Commodities, Crypto |

### Regime Input Indicators

Monitor these key indicators to determine the current regime:

| Indicator              | Growth Signal                        | Inflation Signal                 |
| ---------------------- | ------------------------------------ | -------------------------------- |
| ISM PMI                | >50 = expansion, <50 = contraction   | Prices Paid sub-index            |
| NFP (Nonfarm Payrolls) | >150K = healthy, <0 = recession risk | Wage growth YoY                  |
| GDP                    | >2% = solid, <0% = recession         | GDP deflator                     |
| CPI                    | --                                   | >3% = hot, <2% = cool            |
| Core PCE               | --                                   | Fed's preferred gauge, target 2% |
| 2Y-10Y Spread          | Inverted = recession warning         | --                               |
| VIX                    | <15 = complacency, >30 = fear        | --                               |
| DXY (Dollar Index)     | Strong = tightening conditions       | Weak = inflationary impulse      |
| M2 Money Supply        | Growing = expansionary               | Rapid growth = inflationary      |
| HY Spreads             | <400bps = healthy, >600bps = stress  | --                               |

### Regime Transition Signals

Watch for these early indicators of regime change:

- PMI crossing 50 (expansion/contraction threshold)
- Yield curve slope change (steepening/flattening)
- CPI trend reversal (3-month moving average)
- Fed dot plot shifts vs market expectations
- Credit spread widening/tightening

## Event Impact Profiles

### FOMC Decision

| Scenario         | Equities      | Bonds     | USD       | Crypto     | Gold      |
| ---------------- | ------------- | --------- | --------- | ---------- | --------- |
| Hawkish Surprise | -2 to -5%     | -1 to -3% | +1 to +2% | -5 to -15% | -1 to -3% |
| Dovish Surprise  | +2 to +5%     | +1 to +3% | -1 to -2% | +5 to +15% | +1 to +3% |
| Inline           | -0.5 to +0.5% | flat      | flat      | -1 to +1%  | flat      |

### CPI Release

| Scenario                     | Equities      | Bonds     | USD         | Crypto    | Gold          |
| ---------------------------- | ------------- | --------- | ----------- | --------- | ------------- |
| Hot (>0.3% above consensus)  | -1 to -3%     | -1 to -2% | +0.5 to +1% | -3 to -8% | +0.5 to +1%   |
| Cool (<0.2% below consensus) | +1 to +3%     | +1 to +2% | -0.5 to -1% | +3 to +8% | -0.5 to +0.5% |
| Inline                       | -0.5 to +0.5% | flat      | flat        | -1 to +1% | flat          |

### NFP (Nonfarm Payrolls)

| Scenario                             | Equities      | Bonds         | USD         | Crypto    |
| ------------------------------------ | ------------- | ------------- | ----------- | --------- |
| Strong (>50K above consensus)        | -1 to +1%\*   | -0.5 to -1.5% | +0.5 to +1% | -2 to -5% |
| Weak (<50K below consensus)          | -1 to +1%\*   | +0.5 to +1.5% | -0.5 to -1% | +1 to +3% |
| Goldilocks (within 20K of consensus) | +0.5 to +1.5% | flat          | flat        | +1 to +3% |

\*Equity reaction depends on regime: strong jobs in Goldilocks = positive; strong jobs in Reflation = negative (more hikes).

## Cross-Market Cascade Analysis

### Typical Transmission Chains

Map how one event propagates through markets:

**Fed Hike Cascade:**
Fed Hikes Rate -> Treasury Yields Rise -> USD Strengthens -> Risk Assets Fall -> EM Currencies Weaken -> Commodity Prices Fall -> EM Equities Fall

**Hot CPI Cascade:**
CPI Above Expectations -> Rate Hike Expectations Rise -> Bond Prices Fall -> Growth Stocks Sell Off -> Crypto Follows Risk-Off -> Gold Mixed (inflation hedge vs rate headwind)

**Geopolitical Shock Cascade:**
Conflict/Sanctions -> Oil Prices Spike -> Inflation Expectations Rise -> Flight to Safety (Bonds, Gold, USD) -> Risk Assets Fall -> Supply Chain Disruption Fears

### Portfolio Event Exposure

Cross-reference the user's holdings against upcoming events:

1. Identify which events affect which asset classes in the portfolio
2. Quantify exposure: what percentage of portfolio is sensitive to each event
3. Estimate range of outcomes using historical impact profiles
4. Suggest hedging considerations for high-exposure events

## Response Guidelines

- Start with the most immediately relevant events (today/this week) and their expected impact.
- For regime analysis, clearly state the current classification and confidence level. Show which indicators support and which contradict.
- Present event calendars in chronological table format with importance ratings.
- For event impact analysis, always show the historical average and range -- single-point estimates are misleading.
- When mapping events to portfolios, be specific: "Your 40% BTC allocation is sensitive to Thursday's CPI release. Historically, hot CPI prints have caused BTC to drop 3-8%."
- Highlight regime transition signals prominently -- these have the largest portfolio implications.
- Include the cross-market cascade chain for major events so users understand the transmission mechanism.
- Note the time of economic releases in the user's timezone when possible.

## Risk Disclosures

- Macro regime classification is a framework, not a prediction. Regimes can persist for years or shift rapidly.
- Historical event impact ranges are averages. Individual events can produce outlier moves far outside typical ranges.
- Cross-market cascade analysis describes typical transmission paths. Markets may react differently depending on positioning, liquidity, and concurrent events.
- Economic data is subject to revision. Initial releases may be significantly revised in subsequent months.
- This analysis is informational and does not constitute investment advice. Macro conditions are one of many factors affecting asset prices.
