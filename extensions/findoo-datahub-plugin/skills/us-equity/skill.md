---
name: fin-us-equity
description: "US equity analysis — GAAP financials (us/income), earnings beat/miss with revision cycle, options strategy selection (IV/Greeks via options/chains), Fed rate sensitivity, sector rotation. Data via massive + yfinance. Use when: user mentions US tickers (AAPL/NVDA/TSLA/MSFT), asks about US earnings, options strategies, or Fed impact on equities. NOT for: A-shares (use fin-a-share), HK stocks (use fin-hk-stock), crypto (use fin-crypto), US macro rates only (use fin-macro), US index options (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🇺🇸", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# US Equity Analysis

Use **fin_stock**, **fin_derivatives**, and auxiliary tools for US equity analysis. All data routes through DataHub.

## Symbol Format

US tickers: `AAPL`, `NVDA`, `TSLA`, `MSFT` (no suffix, no exchange code)

## Available Endpoints (US)

### fin_stock (12 endpoints)

| endpoint                        | data                       | use case                                 |
| ------------------------------- | -------------------------- | ---------------------------------------- |
| `price/historical`              | OHLCV                      | price trend, technical overlay           |
| `us/income`                     | US GAAP income statement   | revenue/EPS/margin, quarterly comparison |
| `fundamental/ratios`            | PE/PB/ROE/margins          | valuation snapshot, sector comparison    |
| `fundamental/metrics`           | EV/EBITDA                  | cross-method valuation, comps            |
| `fundamental/earnings_forecast` | analyst consensus EPS      | PEG calc, earnings surprise detection    |
| `fundamental/dividends`         | dividend history           | DDM input, yield analysis                |
| `profile`                       | company overview           | sector, description, market cap          |
| `discovery/gainers`             | top US gainers (no symbol) | market scan                              |
| `discovery/losers`              | top US losers (no symbol)  | market scan                              |
| `us/adj_factor`                 | 复权因子                   | 长期回测价格调整                         |
| `us/trade_cal`                  | 美股交易日历               | 财报季/节假日自动化                      |
| `historical_splits`             | 拆股历史                   | 长期回测需要拆股调整                     |

### fin_derivatives (US Options)

| endpoint         | data                                                       | use case                        |
| ---------------- | ---------------------------------------------------------- | ------------------------------- |
| `options/chains` | full option chain with Greeks (Delta/Gamma/Vega/Theta, IV) | strategy selection, IV analysis |

### Auxiliary Tools

| tool              | endpoint                              | use case                         |
| ----------------- | ------------------------------------- | -------------------------------- |
| `fin_macro`       | `treasury_us`                         | 10Y yield for DCF risk-free rate |
| `fin_macro`       | `libor`                               | USD rate reference               |
| `fin_macro`       | `news/company`                        | company news for US tickers      |
| `fin_ta`          | `sma`, `ema`, `rsi`, `macd`, `bbands` | technical overlay                |
| `fin_data_ohlcv`  | `symbol=AAPL, market=equity`          | OHLCV time series                |
| `fin_data_regime` | `symbol=AAPL, market=equity`          | bull/bear/sideways regime        |

**预计算技术因子:** `fin_stock(fundamental/stock_factor)` → MACD/KDJ/RSI/BOLL/CCI 预计算值（tushare 美股覆盖），可替代逐个 fin_ta 调用。

## Data Sources

| Provider | Coverage                       | Notes              |
| -------- | ------------------------------ | ------------------ |
| massive  | OHLCV + fundamentals           | needs API key      |
| yfinance | price + fundamentals + options | free, ~15min delay |

> **⚠️ US 股票 Provider 注意事项:**
>
> - `price/historical` 默认 tushare provider，对 US 股票返回 500；**必须添加 `provider="yfinance"`**
> - `fundamental/ratios` 仅 tushare provider 可用，对 US 股票返回 204；改用 `fundamental/metrics` (massive) 或 `us/income` 手动计算
> - `fundamental/balance` 路径正确（非 `us/balance`），需确认 provider 支持

## Analysis Patterns

### Earnings Analysis Tree (US Core)

```
Step 1: fin_stock(endpoint="fundamental/earnings_forecast", symbol="AAPL") -> consensus EPS
Step 2: fin_stock(endpoint="us/income", symbol="AAPL") -> actual EPS/revenue
  |-- Beat + guidance raised -> "beat and raise" -> positive revision cycle -> re-rate
  |-- Beat + guidance cut -> "beat and lower" -> mixed -> watch next Q
  |-- Miss + guidance raised -> market forgives -> potential opportunity
  +-- Miss + guidance cut -> negative revision cycle -> valuation compression
Step 3: fin_stock(endpoint="price/historical", symbol="AAPL") -> post-earnings price reaction
  |-- Beat + price drops -> "sell the news" / priced-in / whisper number was higher
  +-- Miss + price rises -> market looks through to forward guidance
```

**Revision cycle:** 3+ consecutive beats with upward revisions -> re-rate; 2+ misses with downward revisions -> de-rate. Track via `earnings_forecast` consensus changes QoQ.

注意: `estimates/consensus` 通过 yfinance 获取，存在频率限制 (rate limit)，高频调用可能 429。备选: `fundamental/earnings_forecast` (tushare, 无限流)。

**Whisper number:** Buy-side "whisper" is typically 2-5% above consensus. A <2% beat on high-expectations names often trades like a miss.

**Earnings season:** Jan (Q4), Apr (Q1), Jul (Q2), Oct (Q3). Banks (week 2) -> mega-cap tech (week 3-4) -> mid/small-cap (weeks 4-6). Consensus revision spike in `earnings_forecast` = approaching report.

### Options Strategy Selector (US Only)

`fin_derivatives(endpoint="options/chains", symbol="AAPL")` -> ATM IV, Greeks, expiry chain. Rank IV against historical percentile:

| IV Level      | Bullish                    | Bearish               | Neutral        |
| ------------- | -------------------------- | --------------------- | -------------- |
| Low (<30th)   | Buy Call / Bull Spread     | Buy Put               | Long Straddle  |
| Mid (30-70th) | Bull Call Spread           | Bear Put Spread       | Iron Condor    |
| High (>70th)  | Sell Put / Bull Put Spread | Sell Call / Bear Call | Short Strangle |

**Earnings straddle:** Pre-earnings IV = 1.5-3x normal. Expected move = ATM straddle / stock price. Compare to last 4 Qs actual moves (`price/historical` open-to-open). Expected > avg -> sell bias; < avg -> buy bias. IV crush collapses 40-60%. Entry: 5-7 days before; exit: at announcement.

### Fed Rate Sensitivity (US Only)

```
fin_macro(endpoint="treasury_us") -> 10Y yield; fin_stock(endpoint="fundamental/ratios") -> PE
  |-- Rate rising + high PE -> rotate to value | Rate falling + low PE -> growth rebounds
  +-- Rate stable -> fundamentals-driven stock picking
```

**Rate chain:** Fed funds -> 2Y -> 10Y -> ERP -> PE compression/expansion. Duration: tech (high), financials (inverse), utilities (high), energy (low).

| Phase            | Favored                    | Avoid                    | Signal                        |
| ---------------- | -------------------------- | ------------------------ | ----------------------------- |
| Early easing     | Tech, Cons Disc, RE        | Energy, Materials        | 10Y falling, curve steepening |
| Late easing      | Mega-cap growth, Small-cap | Utilities, Staples       | 10Y bottoming, spreads tight  |
| Early tightening | Financials, Energy         | Long-duration, REITs     | 10Y rising, curve flattening  |
| Late tightening  | Staples, Healthcare, Utils | Cyclicals, high-leverage | 10Y peaking, curve inverting  |

### US Valuation (DCF)

```
Step 1: fin_macro(endpoint="treasury_us") -> Rf (10Y yield)
Step 2: WACC = Rf + Beta * ERP(4-6%) + spread; Terminal growth = 2-3% (US GDP proxy)
Step 3: fin_stock(endpoint="fundamental/metrics") -> EV/EBITDA comps cross-check
```

### Technical + Regime

```
Step 1: fin_data_ohlcv(symbol="AAPL", market="equity") -> OHLCV
Step 2: fin_ta(indicator="sma/rsi/macd/bbands") -> overlay
Step 3: fin_data_regime(symbol="AAPL", market="equity")
  |-- Bull + RSI<40 -> pullback buy | Bear + RSI>70 -> rally sell
  +-- Sideways + BBands squeeze -> breakout imminent
```

## US-Specific Patterns

### Magnificent 7 / Mega-Cap Concentration

Mag7 (AAPL, MSFT, NVDA, GOOG, AMZN, META, TSLA) = 25-35% of S&P 500 weight.

```
Step 1: For each Mag7: fin_stock(endpoint="fundamental/metrics") -> market cap, FCF
         fin_stock(endpoint="fundamental/ratios") -> PE; fin_stock(endpoint="us/income") -> revenue growth
Step 2: fin_data_ohlcv(market="equity") -> price perf; compare vs fin_index(endpoint="global_index") SPX
  |-- Mag7 outperforming + breadth narrowing -> concentration risk -> hedging warranted
  |-- Mag7 lagging + breadth expanding -> healthy rotation -> equal-weight favored
  +-- Mag7 diverging -> stock-pick within group via earnings/growth differential
```

**Key Mag7 metrics:** Forward PE (`earnings_forecast`), revenue growth (`us/income` sequential Qs), FCF yield (`fundamental/metrics`). NVDA at 2-3x group PE justified only if AI growth sustains 40%+ YoY.

### Dividend Aristocrats

```
Step 1: fin_stock(endpoint="fundamental/dividends", symbol="JNJ") -> dividend history
Step 2: Count consecutive years of dividend growth (annual totals YoY)
  |-- 25+ years -> Aristocrat | 10-24 -> Achiever | <10 or any cut -> not qualified
Step 3: fin_stock(endpoint="fundamental/ratios", symbol="JNJ") -> payout ratio, ROE
  |-- Payout < 60% + ROE > 15% -> sustainable | 60-80% -> watch | >80% -> at risk
Step 4: Yield vs 10Y Treasury (fin_macro endpoint="treasury_us")
  |-- Spread > 1.5% -> attractive income | Spread < 0% -> bonds win
```

Classic sectors: Industrials (MMM, CAT), Healthcare (JNJ, ABT), Staples (PG, KO, PEP).

### Revenue Quality — SaaS (Rule of 40)

```
Step 1: fin_stock(endpoint="us/income", symbol="CRM") -> last 8 quarterly revenues
Step 2: Revenue growth % = (Q_latest / Q_year_ago - 1) * 100
         Gross margin = gross profit / revenue; Op margin = op income / revenue
         Rule of 40 = Revenue growth % + Op margin %
  |-- >40% -> elite SaaS (premium PE) | 25-40% -> solid | <25% -> problem
Step 3: QoQ revenue acceleration across 4 quarters
  |-- Accelerating + margin expanding -> strongest signal
  +-- Decelerating + margin compressing -> re-rate risk
```

### Total Shareholder Yield (Dividend + Buyback)

S&P 500: ~$1T buybacks vs ~$600B dividends annually. Mega-cap tech: buyback yield 3-5%, dividend <1%.

```
fin_stock(endpoint="fundamental/dividends") -> div/share
fin_stock(endpoint="fundamental/metrics") -> market cap, FCF
Buyback yield = (FCF - Dividends) / Mkt cap; Total yield = Div yield + Buyback yield
  |-- >5% -> aggressive (AAPL/META) | 2-5% -> moderate | <2% -> growth reinvestor
```

### Pre/Post-Market Gap Analysis

```
Step 1: fin_stock(endpoint="price/historical", symbol="TSLA") -> multi-day OHLCV
Step 2: Gap % = (Open - prior Close) / prior Close * 100
  |-- >3% + vol >2x -> breakaway | >3% + normal vol -> exhaustion | <-3% + vol >2x -> breakdown
  +-- 0.5-3% -> common gap (fills ~70% in 3 days); earnings gaps >5% fill only ~40% in 30 days
```

### Short Squeeze & Institutional Proxies

No short interest / 13F — use price + volume signatures.

```
Squeeze: fin_data_ohlcv + fin_ta(rsi) -> price >10%/day + vol >5x avg + RSI <30->70 in 5 days
  + fundamental/metrics -> small/mid (<$10B) = high squeeze prob; large = news-driven
Institutional: price/historical vol >3x avg + news/company no catalyst = stealth accumulation
  + fin_data_regime bear->bull + vol spike = institutional re-entry
```

## DataHub Gaps (US)

| Missing           | Workaround                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Earnings calendar | `earnings_forecast` revision spikes signal approaching report + season calendar (Jan/Apr/Jul/Oct) |
| 13F holdings      | `price/historical` vol >2x avg without news = institutional flow proxy                            |
| Short interest    | Price >10%/day + vol >5x avg + RSI whipsaw = squeeze proxy (see pattern above)                    |
| Sector ETF flows  | `discovery/gainers`+`losers` sector clustering + `fundamental/ratios` PE expansion                |
| Real-time quotes  | `fin_data_ohlcv` (~15min delay); caveat to user for time-sensitive analysis                       |
| Intraday OHLCV    | Daily only; gap analysis (open vs prior close) as partial substitute                              |

## Data Boundaries

| Data               | Frequency    | Notes                                                              |
| ------------------ | ------------ | ------------------------------------------------------------------ |
| US quotes          | ~15min delay | yfinance                                                           |
| US GAAP financials | quarterly    | 10-Q (45d), 10-K (60d)                                             |
| Earnings forecast  | consensus    | small-cap may lack coverage; mega-cap (20+ analysts) most reliable |
| Options chains     | ~15min delay | full Greeks (Delta/Gamma/Vega/Theta/IV)                            |
| Dividends          | historical   | ex-date + amount                                                   |
| Company news       | event-driven | `news/company`; may lag real-time by minutes-hours                 |
| US 复权因子        | Daily        | tushare `us/adj_factor` (11397 records)                            |
| US 交易日历        | —            | tushare `us/trade_cal` (预生成至 2026-12-31)                       |
| 拆股历史           | event-driven | `fundamental/historical_splits` (e.g. AAPL 3 records)              |
