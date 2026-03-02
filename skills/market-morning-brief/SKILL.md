---
name: market-morning-brief
description: "UK-focused daily market morning brief: FTSE 100, GBP/USD, key commodities, US pre-market, and top financial headlines. No API key needed. Use when user asks for a market update, morning brief, what markets are doing, or how stocks/indices opened."
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": [] } } }
---

# Market Morning Brief

Pulls a structured UK-focused market snapshot using free public data sources (no API key required). Covers indices, FX, commodities, and top headlines.

## When to Use

✅ **Activate on any of:**

- "morning brief", "market brief", "what are markets doing?"
- "how is FTSE?", "FTSE today", "London markets"
- "market update", "market snapshot", "daily market report"
- "how's GBP doing?", "pound vs dollar"
- "pre-market", "US futures", "what happened overnight?"
- Any request for a financial markets overview before/during/after UK market hours

## Data Sources (all free, no auth)

| Source                                                       | What it gives            |
| ------------------------------------------------------------ | ------------------------ |
| `https://query1.finance.yahoo.com/v8/finance/chart/^FTSE`    | FTSE 100 price + change  |
| `https://query1.finance.yahoo.com/v8/finance/chart/^GSPC`    | S&P 500                  |
| `https://query1.finance.yahoo.com/v8/finance/chart/^IXIC`    | NASDAQ                   |
| `https://query1.finance.yahoo.com/v8/finance/chart/GC=F`     | Gold (USD/oz)            |
| `https://query1.finance.yahoo.com/v8/finance/chart/CL=F`     | WTI Crude (USD/bbl)      |
| `https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X` | GBP/USD                  |
| `https://query1.finance.yahoo.com/v8/finance/chart/GBPEUR=X` | GBP/EUR                  |
| `https://www.bbc.co.uk/news/business/market-data`            | UK market context        |
| `https://www.ft.com/markets`                                 | FT headlines (web_fetch) |

## Output Format

Always return a clean briefing card structured as:

```
📊 MARKET MORNING BRIEF — [Date, London time]

🇬🇧 UK INDICES
  FTSE 100:    [price]  [+/-change]  ([% change])
  FTSE 250:    [price]  [+/-change]  ([% change])

🇺🇸 US INDICES (pre-market or last close)
  S&P 500:     [price]  [+/-change]  ([% change])
  NASDAQ:      [price]  [+/-change]  ([% change])
  Dow Jones:   [price]  [+/-change]  ([% change])

💱 FX
  GBP/USD:     [rate]   [+/-change]
  GBP/EUR:     [rate]   [+/-change]
  USD/JPY:     [rate]   [+/-change]

🛢️ COMMODITIES
  Gold:        $[price]/oz   [+/-change]
  WTI Crude:   $[price]/bbl  [+/-change]
  Brent:       $[price]/bbl  [+/-change]

📰 TOP HEADLINES (3–5 bullets)
  • [headline 1]
  • [headline 2]
  • [headline 3]

⚠️ KEY WATCH (optional: earnings, central bank, macro events today)
```

## How to Fetch Data

Use `web_fetch` on Yahoo Finance chart API (returns JSON). Extract `regularMarketPrice` and `regularMarketChangePercent` from the `result[0].meta` field.

```
# Example: fetch FTSE 100
web_fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?interval=1d&range=1d")
# Parse: result.chart.result[0].meta.regularMarketPrice
#        result.chart.result[0].meta.regularMarketChangePercent
```

For headlines, use `web_fetch` on BBC Business or FT Markets page and extract the top 3–5 stories.

## Rules

1. **Always show change** (points AND percentage) — never just the raw price.
2. **Label pre-market vs live** — if US market is closed, say "pre-market" or "last close".
3. **London timezone** — show the time in GMT/BST, not UTC or US time.
4. **Keep it scannable** — the entire brief should fit in ~20 lines, no waffle.
5. **Add Key Watch** — if it's a day with known events (BoE meeting, Fed minutes, major earnings), flag it.
6. **Fail gracefully** — if a data source times out, show `—` and note the source was unavailable.

## Optional Add-Ons

User can request extras:

- `+ BTC/ETH` → add crypto row (use crypto-tracker skill)
- `+ [TICKER]` → add specific stock (same Yahoo Finance API, just change the symbol)
- `full brief` → include 10 headlines instead of 5
