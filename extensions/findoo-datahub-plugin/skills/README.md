# Findoo DataHub Skills Catalog

> 33 financial analysis skills covering A-share, HK, US, Crypto markets and cross-asset scenarios.
> Each skill is a `skill.md` file that guides LLM routing, tool selection, and analysis patterns.

## Quick Stats

| Market       | Count  | Skills                                                                                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-Share      | 10     | a-share, a-share-radar, a-northbound-decoder, a-index-timer, a-earnings-season, a-dividend-king, a-concept-cycle, a-convertible-arb, a-ipo-new, a-quant-board |
| HK           | 5      | hk-stock, hk-hsi-pulse, hk-dividend-harvest, hk-southbound-alpha, hk-china-internet                                                                           |
| US           | 5      | us-equity, us-earnings, us-dividend, us-etf, us-sector-rotation                                                                                               |
| Crypto       | 6      | crypto, crypto-funding-arb, crypto-defi-yield, crypto-btc-cycle, crypto-stablecoin-flow, crypto-altseason                                                     |
| Cross-Market | 7      | macro, derivatives, etf-fund, factor-screen, cross-asset, risk-monitor, data-query                                                                            |
| **Total**    | **33** |                                                                                                                                                               |

---

## A-Share (10)

### fin-a-share

**Individual A-share deep analysis.** CAS fundamentals (income/balance/cash/ratios), chip structure (shareholders/pledge/lock-up/repurchase), policy-driven sector rotation, capital flow cross-validation.

- Tools: `fin_stock`, `fin_market`, `fin_index`, `fin_ta`
- Triggers: A-share codes (600xxx.SH/000xxx.SZ/300xxx.SZ), Chinese company names

### fin-a-share-radar

**Market-wide A-share monitoring.** Dragon-tiger list, limit-up/down stats, block trades, sector money flow, margin trading, Stock Connect flows, IPO calendar.

- Tools: `fin_market`
- Triggers: market overview, daily recap, unusual activity, institutional flows

### fin-a-northbound-decoder

**Northbound capital decoder.** HSGT daily flows, top 10 holdings, trend analysis, northbound vs domestic divergence, foreign ownership limits.

- Tools: `fin_market` (flow/hsgt_flow, flow/hsgt_top10)
- Triggers: northbound capital, foreign buying, HSGT flows, smart money tracking

### fin-a-index-timer

**Index valuation timer for DCA.** PE/PB percentile scoring, traffic-light signal system, dynamic dollar-cost averaging, multi-index comparison, equity-bond spread.

- Tools: `fin_index`, `fin_macro`
- Triggers: index valuation, DCA timing, PE percentile, CSI 300/500 allocation

### fin-a-earnings-season

**A-share earnings season analysis.** Earnings calendar, consensus surprise, earnings-mine detection (goodwill/receivables/cash flow), post-earnings review.

- Tools: `fin_stock` (fundamental/\*)
- Triggers: earnings reports, financial disclosure schedule, earnings mines

### fin-a-dividend-king

**A-share dividend strategy.** Continuous dividend history, yield screening, payout safety, dividend trap detection, tax-aware income planning (holding period tax rules).

- Tools: `fin_stock` (fundamental/dividends, fundamental/ratios)
- Triggers: high-dividend A-shares, income investing, dividend tax rules

### fin-a-concept-cycle

**Concept/theme hype cycle analysis.** Lifecycle stage detection (launch/ferment/climax/decay), leader identification, limit-up stats, decay warning.

- Tools: `fin_index` (thematic/ths\_\*), `fin_market` (market/limit_list)
- Triggers: concept still tradeable, hot sector stage, theme rally duration

### fin-a-convertible-arb

**A-share convertible bond strategy.** Double-low screening, forced-redemption timing, conversion-price reset (xia xiu) analysis, YTM debt-floor valuation, credit risk assessment. T+0 trading, A-share unique asset class.

- Tools: `fin_derivatives` (convertible/\*), `fin_stock`, `fin_ta`
- Triggers: convertible bonds (codes 11xxxx.SH/12xxxx.SZ), double-low strategy, forced redemption

### fin-a-ipo-new

**A-share IPO subscription guide.** New share calendar, quality assessment, break-even risk warning, quota calculator, post-listing tracking. Covers differences across main board / ChiNext / STAR / BSE.

- Tools: `fin_market` (discovery/new_share), `fin_stock` (profile), `fin_index`
- Triggers: IPO subscription, new share calendar, quota eligibility, break-even risk

### fin-a-quant-board

**Limit-up board quantitative analysis + theme tracking.** Board ladder (consecutive limit-up tiers), theme main-line detection, sentiment cycle positioning (ice/repair/ferment/climax/diverge/decay), leader progression forecast, dragon-tiger institutional analysis, sector rotation rhythm.

- Tools: `fin_market` (market/limit*list, market/top_list, market/top_inst), `fin_index` (thematic/ths*\*)
- Triggers: limit-up counts, consecutive boards, sentiment cycle, theme main lines, leader stocks

---

## Hong Kong (5)

### fin-hk-stock

**Individual HK stock analysis.** IFRS financials, AH premium arbitrage calculation, southbound capital tracking, liquidity trap detection, dividend tax tiers (H-share 20% / red-chip 10%), HKD peg rate transmission via HIBOR.

- Tools: `fin_stock`, `fin_market`, `fin_macro`
- Triggers: HK codes (00700.HK/09988.HK), AH premium, southbound flow

### fin-hk-hsi-pulse

**HSI valuation pulse.** PE/PB percentile, equity risk premium (ERP = 1/PE - HIBOR), historical bottom analogy, regime overlay.

- Tools: `fin_index`, `fin_macro` (HIBOR)
- Triggers: HSI valuation, Hang Seng PE percentile, bottom-fishing HK

### fin-hk-dividend-harvest

**HK dividend strategy.** Tax-adjusted yield, dividend safety score, liquidity filter, yield trap detection. Covers 3-tier tax structure.

- Tools: `fin_stock` (fundamental/dividends, fundamental/ratios)
- Triggers: HK high-yield stocks, dividend income, after-tax yield comparison

### fin-hk-southbound-alpha

**Southbound capital alpha.** Daily/monthly net buy trends, accumulation signals (5-day streak, single-day spike), sector attribution, contrarian bottom-fishing indicator.

- Tools: `fin_market` (flow/ggt_daily, flow/ggt_monthly)
- Triggers: southbound flow trends, mainland money into HK, Stock Connect net buy

### fin-hk-china-internet

**China Internet sector basket.** 5-stock dashboard (Tencent/Alibaba/Meituan/JD/Bilibili), valuation band percentiles, fundamental scorecard, relative strength, regime overlay.

- Tools: `fin_stock`, `fin_index`
- Triggers: China tech stocks, KWEB, China Internet valuation, Tencent vs Alibaba

---

## US Market (5)

### fin-us-equity

**Individual US stock analysis.** GAAP financials, earnings beat/miss with revision cycle, options strategy selection (IV/Greeks), Fed rate sensitivity, sector rotation.

- Tools: `fin_stock`, `fin_derivatives` (options/chains)
- Triggers: US tickers (AAPL/NVDA/TSLA/MSFT), US earnings, options strategies

### fin-us-earnings

**US earnings season analysis.** Earnings calendar, historical beat/miss patterns, pre-earnings IV/straddle pricing, post-earnings price reaction stats.

- Tools: `fin_stock`, `fin_derivatives`
- Triggers: earnings dates, beat/miss history, earnings straddle, IV crush

### fin-us-dividend

**US dividend strategy.** Aristocrat/Achiever/King classification, payout safety scoring, dividend yield vs Treasury spread, total shareholder yield (dividend + buyback).

- Tools: `fin_stock` (fundamental/dividends, fundamental/ratios)
- Triggers: dividend stocks, passive income, payout safety, ex-dividend dates

### fin-us-etf

**US ETF analysis.** SPY/QQQ/VOO/VTI/SCHD comparison, expense ratio + AUM + tracking error framework, core-satellite portfolio construction, sector ETF rotation, DCA simulation.

- Tools: `fin_index`, `fin_stock`
- Triggers: US ETF selection, passive investing, ETF comparison, sector ETFs

### fin-us-sector-rotation

**US sector rotation.** GICS 11-sector ETF scoreboard (XLK/XLF/XLE...), economic cycle positioning, sector vs SPY relative strength, valuation by sector.

- Tools: `fin_index`, `fin_stock`, `fin_macro`
- Triggers: sector rotation, which industry to buy, economic cycle stage

---

## Crypto (6)

### fin-crypto

**General crypto analysis.** CEX market data (ticker/orderbook/funding rate), DeFi protocols (TVL/fees/yields/stablecoins via DefiLlama), market metrics (CoinGecko). 21 DataHub endpoints.

- Tools: `fin_crypto`
- Triggers: crypto prices, DeFi protocols, funding rates, stablecoin flows, token valuation

### fin-crypto-funding-arb

**Funding rate arbitrage.** Perpetual funding rates, delta-neutral yield, cross-exchange rate spread, annualized return calculator.

- Tools: `fin_crypto` (market/funding_rate, market/ticker)
- Triggers: funding rate, delta-neutral strategy, basis trading, perpetual vs spot arb

### fin-crypto-defi-yield

**DeFi yield analysis.** Yield farming opportunities, protocol safety scoring, TVL trend verification, risk-adjusted return comparison across chains.

- Tools: `fin_crypto` (defi/\*)
- Triggers: DeFi yields, staking APY, lending rates, protocol safety

### fin-crypto-btc-cycle

**BTC halving cycle analysis.** Cycle positioning (days since halving), four-phase detection (accumulation/markup/euphoria/decline), multi-signal validation.

- Tools: `fin_crypto`, `fin_data_ohlcv`, `fin_data_regime`
- Triggers: BTC cycle position, halving impact, bull/bear phase

### fin-crypto-stablecoin-flow

**Stablecoin capital flow analysis.** USDT/USDC/DAI market cap trends, 4-week rolling inflow as leading indicator, chain distribution, stablecoin-to-total-market ratio.

- Tools: `fin_crypto` (defi/stablecoins, market/tickers)
- Triggers: stablecoin supply, capital inflow/outflow, OTC demand

### fin-crypto-altseason

**Altseason timing.** BTC dominance trend, Altseason Index (Top 50 vs BTC), ETH/BTC ratio, category rotation radar, capital rotation ladder.

- Tools: `fin_crypto` (market/ticker, market/tickers)
- Triggers: altseason, BTC dominance, ETH/BTC ratio, altcoin rotation

---

## Cross-Market (7)

### fin-macro

**Macroeconomic analysis.** China GDP/CPI/PPI/PMI/M2/social financing, interest rates (Shibor/LPR/Libor/Hibor), CN/US treasury yields, FX rates, economic calendar.

- Tools: `fin_macro`
- Triggers: economic indicators, monetary policy, rate differentials, yield curve

### fin-derivatives

**Derivatives analysis.** Futures (daily/holdings/settlement/curve), options (basic/daily/chains with Greeks), convertible bonds. 12 DataHub endpoints.

- Tools: `fin_derivatives`
- Triggers: futures prices, term structure, options strategies, Greeks

### fin-etf-fund

**ETF and fund analysis.** NAV, holdings, manager track record, fees, index tracking, adjusted NAV.

- Tools: `fin_index`, `fin_stock`
- Triggers: ETF selection, fund comparison, portfolio construction

### fin-factor-screen

**Multi-factor stock screening.** Value (PE/PB/dividend), quality (ROE/ROIC/OCF), growth (revenue/earnings), momentum (price/RSI/SMA), capital flow factors.

- Tools: `fin_stock`, `fin_index`, `fin_ta`
- Triggers: screen stocks by criteria, factor portfolios, stock ranking

### fin-cross-asset

**Cross-asset correlation and allocation.** Stock-bond-FX-commodity linkage, Merrill Clock positioning, risk parity signals.

- Tools: `fin_macro`, `fin_index`, `fin_market`, `fin_derivatives`
- Triggers: asset allocation, cross-market correlation, stock-bond relationship

### fin-risk-monitor

**Risk monitoring dashboard.** Market regime detection, rate risk (Shibor/treasury spread), leverage risk (margin), foreign capital flows, macro warning signals.

- Tools: `fin_data_regime`, `fin_macro`, `fin_market`, `fin_index`
- Triggers: market risk assessment, stress signals, hedging recommendations

### fin-data-query

**Generic DataHub query fallback.** Access any of 168+ financial data endpoints by path. OHLCV candle data with caching, market regime detection, supported markets listing.

- Tools: `fin_data_ohlcv`, `fin_data_regime`, `fin_query`
- Triggers: uncommon endpoints, raw data access, edge-case queries

---

## Routing Architecture

```
User Query
  |
  v
LLM reads skill descriptions (name + "Use when" + "NOT for")
  |
  v
Selects best-match skill.md
  |
  v
Follows Analysis Patterns (step-by-step with tool calls)
  |
  v
Applies Response Guidelines (format, disclaimers, data sources)
```

**Design Principles:**

1. **Decision Map** — Each skill has numbered analysis steps with conditional branches
2. **Precise Routing** — `When to Use` + `When NOT to Use` prevent misrouting
3. **Financial Intelligence** — Domain-specific knowledge embedded (tax rules, trading rules, risk models)
4. **Guide LLM Behavior** — Analysis patterns with warning/insight annotations guide reasoning
5. **Data Transparency** — Data Notes section documents latency, update frequency, and limitations
