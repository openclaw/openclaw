---
name: openbb
description: Query financial market data via the OpenBB Platform. Use when the user asks about stock prices, market data, economic indicators, ETFs, crypto, forex, fixed income, commodities, SEC filings, FRED data, news, or any financial research. Supports historical prices, fundamentals, screeners, and more. NOT for: trading/order execution, portfolio management, or financial advice.
metadata:
  {
    "openclaw":
      { "emoji": "📈", "requires": { "anyBins": ["python3"], "pip": ["openbb"] } },
  }
---

# OpenBB Financial Data

Query financial markets using the OpenBB Platform Python SDK.

## Prerequisites

OpenBB must be installed: `pip install openbb`

For premium data, users can set provider API keys:
```python
obb.user.credentials["fmp_api_key"] = "YOUR_KEY"
```

The free `yfinance` provider works for most equity/ETF/crypto queries without any API key.

## Quick Reference

Run queries via the bundled helper script:

```bash
python3 SKILL_DIR/scripts/openbb_query.py <COMMAND> [OPTIONS]
```

### Commands

| Command | Description | Example |
|---------|-------------|---------|
| `price` | Historical price data | `price AAPL --days 30` |
| `quote` | Current quote/snapshot | `quote AAPL MSFT GOOGL` |
| `search` | Search for securities | `search "artificial intelligence"` |
| `news` | Financial news | `news AAPL --limit 5` |
| `income` | Income statement | `income AAPL --period annual --limit 4` |
| `balance` | Balance sheet | `balance AAPL --period annual --limit 4` |
| `cash` | Cash flow statement | `cash AAPL --period annual --limit 4` |
| `crypto` | Crypto price history | `crypto BTC-USD --days 7` |
| `forex` | Currency exchange rates | `forex EUR/USD --days 30` |
| `economy` | Economic indicators | `economy GDP --country united_states` |
| `etf` | ETF data | `etf SPY --days 30` |
| `index` | Market index data | `index ^GSPC --days 30` |

### Options

| Flag | Description |
|------|-------------|
| `--days N` | Lookback period in days (default: 30) |
| `--period P` | annual / quarter (for fundamentals) |
| `--limit N` | Number of results |
| `--provider P` | Data provider (default: yfinance) |
| `--output FORMAT` | table / json / csv (default: table) |

## Direct Python Usage

For complex queries not covered by the helper, use Python directly:

```python
from openbb import obb

# Equity screener
obb.equity.screener(provider="fmp", market_cap_min=1e10)

# Treasury rates
obb.fixedincome.rate.ameribor(provider="fred")

# SEC filings
obb.regulators.sec.filings(symbol="AAPL", type="10-K", provider="sec")

# Economic calendar
obb.economy.calendar(provider="fmp")
```

## Output Formatting

- For chat messages, present data as concise bullet points or small tables
- For large datasets, summarize key metrics (high/low/change/volume)
- Include percentage changes when showing price data
- Use emoji for trend direction: 📈 up, 📉 down, ➡️ flat
