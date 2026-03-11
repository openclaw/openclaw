---
name: fin-news-intel
status: draft
description: "Financial news intelligence - multi-source sentiment scoring, event impact analysis, historical analogies, and personalized portfolio-aware digests."
metadata:
  {
    "openclaw":
      {
        "emoji": "📰",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# News Intelligence

AI-powered news analysis that goes beyond headlines. Multi-source sentiment scoring, event impact classification, historical analogy matching, and personalized digests tailored to your portfolio.

## When to Use

**USE this skill when:**

- "what's happening with BTC" / "why is ETH dropping"
- "market news" / "crypto news today"
- "sentiment on SOL" / "is the market bullish"
- "news digest" / "morning briefing"
- "how will the Fed decision affect my portfolio"
- "impact analysis" / "what does this hack mean for DeFi"
- "compare sentiment vs price"
- "what happened last time CPI was hot"

## When NOT to Use

**DON'T use this skill when:**

- User just wants a price quote -- use fin-market-data
- User wants to execute a trade -- use fin-trading
- User wants deep technical analysis -- use fin-expert
- User wants to set price alerts -- use fin-alerts
- User wants portfolio risk metrics -- use fin-risk-manager

## Tools

### Existing Tools

- `fin_info_search` -- search for news articles and social media posts
- `fin_info_subscribe` -- subscribe to news feeds for specific assets or topics
- `fin_info_digest` -- generate a personalized news digest
- `fin_market_price` -- fetch price data for correlation with news events
- `fin_portfolio_positions` -- fetch user holdings for portfolio-relevant filtering

### News-Specific Tools (Documented)

- `fin_sentiment_score` -- compute multi-source sentiment composite
  - Parameters: `asset` (ticker or topic), `timeframe` (1h | 4h | 24h | 7d)
  - Returns: composite score (-1 to +1), per-source breakdown, Fear/Greed classification, divergence flags

- `fin_news_impact` -- classify event impact and find historical analogies
  - Parameters: `event_description`, `affected_assets[]`, `event_type` (regulatory | hack | earnings | macro | upgrade | rumor)
  - Returns: impact tier (S/A/B/C), estimated price impact range, 3-5 historical analogies with actual outcomes

## Sentiment Analysis Framework

### Multi-Source Weighted Composite

Aggregate sentiment from 6 sources with quality-weighted scoring:

| Source          | Weight | Signal Type                                          |
| --------------- | ------ | ---------------------------------------------------- |
| News Articles   | 30%    | Editorial sentiment, headline tone, publication tier |
| Social Media    | 20%    | Volume spikes, influencer signals, hashtag momentum  |
| On-Chain Data   | 15%    | Exchange flows, active addresses, whale movements    |
| Options Market  | 15%    | Put/call ratio, implied volatility skew, max pain    |
| Funding Rates   | 10%    | Perpetual futures funding (positive = longs paying)  |
| Analyst Ratings | 10%    | Consensus changes, price target revisions            |

Composite score ranges:

- **Extreme Fear** (-1.0 to -0.6): Potential contrarian buy signal
- **Fear** (-0.6 to -0.2): Cautious sentiment, watch for capitulation
- **Neutral** (-0.2 to +0.2): No clear directional bias
- **Greed** (+0.2 to +0.6): Bullish momentum, watch for overextension
- **Extreme Greed** (+0.6 to +1.0): Potential contrarian sell signal

### Divergence Detection

Flag when price action diverges from sentiment:

- **Bullish divergence**: Price falling but sentiment improving -- potential reversal signal
- **Bearish divergence**: Price rising but sentiment deteriorating -- potential top signal
- Require minimum 3-day divergence duration to filter noise

## Event Impact Classification

### Impact Tiers

| Tier | Category | Typical Impact | Examples                                                            |
| ---- | -------- | -------------- | ------------------------------------------------------------------- |
| S    | Systemic | 10-50%+        | Exchange collapse, major regulatory ban, protocol hack >$500M       |
| A    | Major    | 3-10%          | Fed rate decision surprise, ETF approval/rejection, earnings miss   |
| B    | Moderate | 1-3%           | Analyst upgrades, partnership announcements, minor protocol updates |
| C    | Minor    | 0-1%           | Rumors, influencer posts, minor news                                |

### Historical Analogy Engine

For each event:

1. Identify 3-5 similar past events by type and market context
2. Measure actual price impact at 1h, 24h, and 7d after event
3. Calculate average impact and standard deviation
4. Note reversal rate (% of events where initial move reversed within 7d)
5. Flag if current market regime differs significantly from historical events

## Digest Framework

### 4-Layer Personalized Digest

Generate digests with relevance-sorted layers:

1. **Portfolio-Relevant**: News directly affecting user's current holdings. Highest priority. Include estimated position impact.
2. **Watchlist**: News about assets on user's watchlist or recently searched.
3. **Market-Macro**: Broad market events, regulatory changes, macro data releases.
4. **Alpha Signals**: Unusual activity, sentiment divergences, or emerging narratives that may present opportunities.

Each item includes: headline, source, timestamp, impact tier, sentiment shift, and relevance score.

## Response Guidelines

- Always lead with the "so what" -- start with portfolio impact before diving into details.
- When explaining why an asset moved, cite specific sources and data points.
- For sentiment scores, show the per-source breakdown so users can see which signals are driving the composite.
- For event impact analysis, always include historical analogies with actual outcomes -- "Last time X happened, BTC moved Y% over Z days."
- Flag divergences prominently -- these are the highest-value signals.
- For digests, clearly separate the 4 layers and indicate which items are most actionable.
- Include timestamps and source links for all news items.
- When sentiment is at extremes (>0.6 or <-0.6), explicitly note the contrarian perspective.

## Risk Disclosures

- Sentiment analysis is probabilistic, not predictive. High sentiment scores do not guarantee price direction.
- Historical analogies provide context but every event occurs in a unique market environment.
- Social media sentiment can be manipulated. Weight institutional sources and on-chain data more heavily for high-stakes decisions.
- News-based trading carries significant risk. Prices often move before news becomes widely available.
