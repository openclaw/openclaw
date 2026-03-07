---
name: fin-us-etf
description: "US ETF analysis — SPY/QQQ/VOO/VTI/SCHD comparison, expense ratio + AUM + tracking error framework, core-satellite portfolio construction, sector ETF rotation (XLK/XLF/XLE), DCA simulation. Use when: user asks about US ETF selection, passive investing, ETF comparison, sector ETFs, or ETF portfolio allocation. NOT for: A-share ETFs/funds (use fin-etf-fund), individual US stocks (use fin-us-equity), crypto (use fin-crypto), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "🏦", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# US ETF Analysis

US ETFs = the safest entry point for retail investors into US equities. Compare, construct portfolios, and simulate DCA returns.

> **Scope boundary:** This skill covers US-listed ETFs (SPY, QQQ, VOO, etc.). For A-share ETFs (510300.SH) and mainland funds, use `/fin-etf-fund`. For individual US stocks, use `/fin-us-equity`.

## When to Use

- "SPY 和 VOO 哪个好" / "SPY vs VOO comparison"
- "科技 ETF 有哪些" / "What tech ETFs are available"
- "怎么配置 ETF 组合" / "How to build an ETF portfolio"
- "QQQ 今年表现怎么样" / "QQQ performance this year"
- "定投 VOO 30 年能赚多少" / "DCA into VOO for 30 years"
- "SCHD 和 VYM 哪个分红更好" / "SCHD vs VYM dividend comparison"
- "行业 ETF 现在买什么" / "Which sector ETF to buy now"

## When NOT to Use

- A 股 ETF / 场内基金 (510300.SH, 159919.SZ) -> use `/fin-etf-fund`
- 场外基金 / 基金经理分析 -> use `/fin-etf-fund`
- US 个股深度分析 (AAPL, NVDA) -> use `/fin-us-equity`
- 加密货币 / DeFi -> use `/fin-crypto`
- 宏观利率 / 国债收益率 -> use `/fin-macro`
- US options/derivatives -> use `/fin-us-equity` (options section)

## Tools & Parameters

### fin_stock (ETF price + fundamentals)

| Parameter | Type   | Required | Format    | Default | Example          |
| --------- | ------ | -------- | --------- | ------- | ---------------- |
| symbol    | string | Yes      | US ticker | —       | SPY              |
| endpoint  | string | Yes      | see below | —       | price/historical |
| provider  | string | No       | yfinance  | auto    | yfinance         |
| limit     | number | No       | 1-5000    | 200     | 250              |

> **Important:** For US ETFs, always use `provider="yfinance"` with `price/historical`. Default tushare provider returns 500 for US symbols.

#### Endpoints for ETFs

| endpoint                | Description              | Example                                                                     |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `price/historical`      | ETF OHLCV price history  | `fin_stock(symbol="SPY", endpoint="price/historical", provider="yfinance")` |
| `fundamental/dividends` | ETF dividend history     | `fin_stock(symbol="SPY", endpoint="fundamental/dividends")`                 |
| `fundamental/ratios`    | Basic ratios (yield)     | `fin_stock(symbol="SPY", endpoint="fundamental/ratios")`                    |
| `fundamental/metrics`   | Key metrics (market cap) | `fin_stock(symbol="SPY", endpoint="fundamental/metrics")`                   |
| `profile`               | ETF description + sector | `fin_stock(symbol="SPY", endpoint="profile")`                               |

### fin_index (for benchmark comparison)

| endpoint       | Description               | Example                                                  |
| -------------- | ------------------------- | -------------------------------------------------------- |
| `constituents` | Index constituents        | `fin_index(endpoint="constituents", symbol="000300.SH")` |
| `daily_basic`  | Index valuation (A-share) | N/A for US — use `price/historical` on index ETF instead |

### fin_data_ohlcv (K-line data)

| Parameter | Type   | Required | Default | Example |
| --------- | ------ | -------- | ------- | ------- |
| symbol    | string | Yes      | —       | SPY     |
| market    | string | No       | equity  | equity  |
| timeframe | string | No       | 1d      | 1w      |
| limit     | number | No       | 200     | 250     |

### Auxiliary Tools

| tool              | use case                            |
| ----------------- | ----------------------------------- |
| `fin_macro`       | `treasury_us` for risk-free rate    |
| `fin_ta`          | RSI/SMA/MACD for timing             |
| `fin_data_regime` | Market regime for allocation adjust |

## US ETF Knowledge Base

> DataHub cannot directly query expense ratio, AUM, or tracking error. The following reference data enables analysis.

### Core Broad Market ETFs

| Ticker | Index           | Expense Ratio | AUM ($B) | Style        |
| ------ | --------------- | ------------- | -------- | ------------ |
| SPY    | S&P 500         | 0.09%         | ~550     | Large Cap    |
| VOO    | S&P 500         | 0.03%         | ~450     | Large Cap    |
| IVV    | S&P 500         | 0.03%         | ~500     | Large Cap    |
| VTI    | Total US Market | 0.03%         | ~400     | Total Market |
| QQQ    | Nasdaq 100      | 0.20%         | ~280     | Large Growth |
| QQQM   | Nasdaq 100      | 0.15%         | ~30      | Large Growth |
| IWM    | Russell 2000    | 0.19%         | ~70      | Small Cap    |
| DIA    | Dow Jones 30    | 0.16%         | ~35      | Large Value  |
| RSP    | S&P 500 EW      | 0.20%         | ~50      | Equal Weight |

### Dividend/Income ETFs

| Ticker | Focus               | Expense Ratio | Yield | Style       |
| ------ | ------------------- | ------------- | ----- | ----------- |
| SCHD   | Dividend Growth     | 0.06%         | ~3.5% | Quality Div |
| VYM    | High Dividend Yield | 0.06%         | ~3.0% | High Yield  |
| DVY    | Select Dividend     | 0.38%         | ~3.8% | High Yield  |
| DGRO   | Dividend Growth     | 0.08%         | ~2.3% | Growth Div  |
| HDV    | High Dividend       | 0.08%         | ~3.5% | Defensive   |

### Sector ETFs (SPDR Select Sector)

| Ticker | Sector           | Expense Ratio | Economic Cycle Phase |
| ------ | ---------------- | ------------- | -------------------- |
| XLK    | Technology       | 0.09%         | Early/Late Expansion |
| XLF    | Financials       | 0.09%         | Early Recovery       |
| XLE    | Energy           | 0.09%         | Late Cycle/Inflation |
| XLV    | Healthcare       | 0.09%         | Defensive/Late Cycle |
| XLU    | Utilities        | 0.09%         | Recession/Defensive  |
| XLI    | Industrials      | 0.09%         | Early Recovery       |
| XLB    | Materials        | 0.09%         | Mid Cycle/Inflation  |
| XLP    | Consumer Staples | 0.09%         | Recession/Defensive  |
| XLY    | Consumer Disc    | 0.09%         | Early Recovery       |
| XLRE   | Real Estate      | 0.09%         | Rate Sensitive       |
| XLC    | Communication    | 0.09%         | Growth-oriented      |

### Factor ETFs

| Ticker | Factor    | Expense Ratio | Use Case                    |
| ------ | --------- | ------------- | --------------------------- |
| MTUM   | Momentum  | 0.15%         | Trend following             |
| QUAL   | Quality   | 0.15%         | Defensive growth            |
| VLUE   | Value     | 0.15%         | Mean reversion / contrarian |
| SIZE   | Small Cap | 0.15%         | Small cap premium           |
| USMV   | Min Vol   | 0.15%         | Low volatility              |

### Bond ETFs (for portfolio construction)

| Ticker | Focus             | Expense Ratio | Duration | Use Case          |
| ------ | ----------------- | ------------- | -------- | ----------------- |
| AGG    | US Aggregate Bond | 0.03%         | ~6yr     | Core bond holding |
| BND    | Total Bond Market | 0.03%         | ~6yr     | Core bond holding |
| TLT    | 20+ Year Treasury | 0.15%         | ~17yr    | Rate bet / hedge  |
| SHV    | Short Treasury    | 0.15%         | <1yr     | Cash equivalent   |
| TIP    | TIPS              | 0.19%         | ~7yr     | Inflation hedge   |

## ETF Comparison Analysis Pattern

1. **Price Performance** `fin_stock(endpoint="price/historical", symbol="SPY", provider="yfinance", limit=250)` — YTD + 1Y price comparison
   - Pull historical prices for each ETF being compared
   - Calculate: YTD return, 1Y return, 3Y annualized, max drawdown
   - ⚠️ If comparing SPY vs VOO, note they track the same index — difference is mainly expense ratio and liquidity
   - 💡 For fair comparison, use total return (price + dividends reinvested) — approximate by adding annual dividend yield

2. **Dividend Analysis** `fin_stock(endpoint="fundamental/dividends", symbol="SCHD")` — Yield + growth
   - Compare: current yield, 5-year dividend CAGR, payout consistency
   - ⚠️ High yield (>5%) in equity ETFs may indicate value trap constituents
   - 💡 Dividend growth rate matters more than current yield for long-term compounding

3. **Risk Metrics** — Calculate from price history
   - Annualized volatility = stdev(daily returns) \* sqrt(252)
   - Sharpe ratio = (annualized return - risk-free rate) / annualized volatility
   - Max drawdown = largest peak-to-trough decline
   - Use `fin_macro(endpoint="treasury_us")` for risk-free rate
   - ⚠️ Sharpe < 0.5 = poor risk-adjusted return; > 1.0 = excellent
   - 💡 Compare Sharpe across ETFs rather than raw returns for quality assessment

4. **Cost Analysis** — Reference knowledge base above
   - Expense ratio difference impact: $100K invested, 0.06% difference = $60/year, ~$3,000 over 30 years (compounded)
   - ⚠️ For identical-index ETFs (SPY/VOO/IVV), always recommend lowest expense ratio unless liquidity requirements differ

## Portfolio Construction Patterns

### Core-Satellite Strategy

| Component | Weight | ETF Selection        | Criteria                          |
| --------- | ------ | -------------------- | --------------------------------- |
| Core      | 60-70% | VOO or VTI           | Lowest cost broad market exposure |
| Satellite | 20-30% | Sector/thematic ETFs | Momentum + conviction-based       |
| Income    | 0-15%  | SCHD or AGG          | Dividend income or bond ballast   |

### Classic Portfolio Templates

| Portfolio       | Allocation                            | Risk Level | Best For          |
| --------------- | ------------------------------------- | ---------- | ----------------- |
| US 60/40        | 60% VOO + 40% AGG                     | Moderate   | Conservative      |
| All-Weather     | 30% VTI + 40% TLT + 15% TIP + 15% GLD | Low-Med    | All conditions    |
| Growth          | 50% QQQ + 30% VOO + 20% IWM           | High       | Long-term growth  |
| Dividend Income | 40% SCHD + 30% VYM + 30% AGG          | Low-Med    | Income generation |
| Lazy 3-Fund     | 60% VTI + 30% VXUS + 10% BND          | Moderate   | Set-and-forget    |

### DCA Simulation Pattern

```
Input: monthly_amount, etf_symbol, years
Step 1: fin_stock(price/historical, limit=years*250) -> daily prices
Step 2: For each month, calculate shares_bought = monthly_amount / price_on_date
Step 3: Total shares * current price = current value
Step 4: Total invested = monthly_amount * months
Step 5: Return = (current_value - total_invested) / total_invested
```

Historical DCA benchmarks (for context, not prediction):

- SPY 10-year DCA: ~10-12% annualized (2015-2025)
- QQQ 10-year DCA: ~15-18% annualized (2015-2025)
- SCHD 10-year DCA: ~9-11% annualized (2015-2025)

### Sector ETF Rotation Pattern

1. **Sector Scoreboard** — Pull price/historical for all 11 sector ETFs (XLK through XLC)
   - Calculate: 1W, 1M, 3M relative returns vs SPY
   - Rank by momentum (3M relative return)
   - ⚠️ Sector leading for > 6 months with decelerating momentum = potential mean reversion
   - 💡 Cross-validate with `fin_data_regime` — defensive sectors (XLU/XLP/XLV) outperform in bear/volatile regimes

2. **Economic Cycle Mapping** — Use `fin_macro(endpoint="treasury_us")` for yield curve context
   - Early recovery: XLF, XLY, XLI (rate-sensitive, cyclical)
   - Mid cycle: XLK, XLC (growth acceleration)
   - Late cycle: XLE, XLB (commodity/inflation beneficiaries)
   - Recession: XLU, XLP, XLV (defensive, low beta)
   - ⚠️ If 2Y-10Y spread inverted (< 0) -> late cycle/recession signal, rotate to defensives

3. **Rebalancing Signal** — Monthly check
   - If top sector 3M return > SPY +10% AND RSI > 70 -> overbought, consider trimming
   - If bottom sector 3M return < SPY -10% AND RSI < 30 -> oversold, consider adding
   - 💡 Sector rotation is not about catching tops/bottoms — it's about gradual tilt adjustments

## Data Notes

- **yfinance ETF data**: ~15min delay, covers price/dividends/basic fundamentals. Always specify `provider="yfinance"` for US ETFs
- **Missing from DataHub**: ETF holdings (constituent weights), AUM (assets under management), expense ratio (use knowledge base above), tracking error, fund flows, net asset value (use closing price as proxy)
- **Expense ratio / AUM**: Hardcoded in knowledge base above. Values are approximate and updated periodically. For exact current figures, advise user to check fund provider website
- **Dividend data**: `fundamental/dividends` returns historical ex-date + amount. Calculate trailing 12M yield = sum of last 4 quarterly dividends / current price
- **Total return approximation**: Daily price return + (annual dividend yield / 252) for rough total return. Not perfectly accurate but sufficient for comparison
- **Bond ETFs**: Price history available but duration/credit quality metrics are from knowledge base, not live data

## Response Guidelines

### Number Formats

- ETF price: $452.30 (2 decimal places)
- Returns: +12.5% / -3.2% (always with +/- sign, 1 decimal)
- Expense ratio: 0.03% (2 decimal places)
- AUM: $450B / $35B (use $B)
- Dividend yield: 3.5% (1 decimal)
- Sharpe ratio: 1.05 (2 decimal)
- Dollar amounts in DCA: $10,000 -> $285,000 (round to nearest thousand for large projections)

### Must Include

- Data timestamp ("Data as of YYYY-MM-DD")
- Expense ratio for every ETF mentioned (from knowledge base)
- Performance comparison must include at least 1Y timeframe
- Risk disclaimer for any forward-looking projection ("Past performance does not guarantee future results")
- Note when data comes from embedded knowledge base vs live DataHub query

### Display Format

- ETF comparison -> side-by-side table (ticker, expense ratio, 1Y return, yield, Sharpe)
- Portfolio construction -> allocation table with weights + rationale
- DCA simulation -> input assumptions + result table + compound growth note
- Sector rotation -> ranked table with momentum scores + economic cycle annotation
- Single ETF analysis -> structured sections: Overview, Performance, Risk, Dividend, Verdict
- Always include actionable takeaway: "For most investors, [recommendation] because [reason]"
