---
name: crypto-tracker
description: "Real-time crypto prices, 24h changes, market caps, and trends for BTC, ETH, and any altcoin. Uses CoinGecko free API (no key needed). Use when user asks about crypto prices, Bitcoin price, coin performance, or wants a crypto market overview."
metadata: { "openclaw": { "emoji": "₿", "requires": { "bins": [] } } }
---

# Crypto Tracker

Real-time cryptocurrency prices and market data via the CoinGecko free API — no API key required.

## When to Use

✅ **Activate on:**

- "Bitcoin price", "BTC price", "how is BTC doing?"
- "ETH price", "Ethereum"
- "crypto prices", "crypto market"
- "[coin name] price" or "[TICKER] price" (e.g., "SOL price", "DOGE")
- "crypto portfolio", "top coins today"
- "is [coin] up or down?"
- "crypto market cap", "dominance"
- Anything about altcoins, DeFi tokens, memecoin prices

## API Endpoints (No Key Needed)

```
# Single coin price + 24h change
https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,gbp&include_24hr_change=true&include_market_cap=true

# Top N coins by market cap
https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false

# Search for a coin by name/ticker
https://api.coingecko.com/api/v3/search?query=solana

# Coin detail (price, ATH, description)
https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false
```

## Common Coin IDs (CoinGecko format)

| Ticker | CoinGecko ID  |
| ------ | ------------- |
| BTC    | bitcoin       |
| ETH    | ethereum      |
| SOL    | solana        |
| BNB    | binancecoin   |
| XRP    | ripple        |
| ADA    | cardano       |
| DOGE   | dogecoin      |
| AVAX   | avalanche-2   |
| MATIC  | matic-network |
| DOT    | polkadot      |
| LINK   | chainlink     |
| UNI    | uniswap       |

For unknown tickers, use the `/search` endpoint first to resolve the CoinGecko ID.

## Output Format

### Single Coin

```
₿ BITCOIN (BTC)              [timestamp]
Price (USD):    $[price]
Price (GBP):    £[price]
24h Change:     [+/-]%  [▲/▼ emoji]
24h High/Low:   $[high] / $[low]
Market Cap:     $[cap]
24h Volume:     $[volume]
ATH:            $[ath]  ([% from ATH])
```

### Multi-Coin Overview

```
₿ CRYPTO SNAPSHOT — [timestamp]

  Coin    Price (USD)   24h %    Mkt Cap
  BTC     $[price]      [+/-]%   $[cap]
  ETH     $[price]      [+/-]%   $[cap]
  SOL     $[price]      [+/-]%   $[cap]
  ...

  BTC Dominance: [%]   Total Cap: $[total]
```

## Rules

1. **Always show 24h % change with direction** — use ▲ for positive, ▼ for negative.
2. **Show both USD and GBP** when user is UK-based (default: include GBP for Dave).
3. **Handle unknown tickers** — if the user asks for an obscure coin, search CoinGecko first, then fetch.
4. **Rate limit awareness** — CoinGecko free tier allows ~10–30 req/min. Don't batch more than 5 coins per call without combining IDs in one request.
5. **No financial advice** — report prices only, no buy/sell recommendations (that's ULTRON's domain).
6. **Timestamps matter** — always show when the data was fetched (CoinGecko returns `last_updated`).

## Integration with ULTRON

When ULTRON needs current crypto prices as part of a trade analysis, it may call crypto-tracker for up-to-date spot data. The two skills complement each other: crypto-tracker = current data, ULTRON = analysis and signals.
