---
name: fin-us-dividend
description: "US dividend strategy — Aristocrat/Achiever/King classification, payout safety scoring, dividend yield vs Treasury spread, total shareholder yield (dividend + buyback), tax-adjusted yield for non-US investors, dividend portfolio construction. Use when: user asks about dividend stocks, passive income, payout safety, ex-dividend dates, or dividend vs bond yield. NOT for: single-stock fundamentals/valuation (use fin-us-equity), A-share dividends (use fin-a-share), crypto yield (use fin-crypto-defi), macro rates only (use fin-macro)."
metadata: { "openclaw": { "emoji": "💰", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# US Dividend Strategy

Specialized in systematic dividend investing: Aristocrat classification, payout sustainability scoring, yield-vs-Treasury comparison, and portfolio construction. Goes beyond fin-us-equity's basic dividend lookup with a full income-investing framework.

## When to Use

- "美股有哪些高股息股" / "Best US dividend stocks"
- "JNJ 连续派息多少年" / "How many years has JNJ raised dividends"
- "股息 vs 国债收益率哪个划算" / "Dividend yield vs Treasury yield comparison"
- "T 的股息安全吗，会不会砍息" / "Is AT&T's dividend safe"
- "10 万美元做股息投资，30 年后多少" / "DRIP simulation for $100K over 30 years"
- "哪些是 Dividend Kings" / "List of Dividend Kings"
- "非美国人买美股股息要交多少税" / "Dividend withholding tax for non-US investors"

## When NOT to Use

- 个股基本面/估值深度分析 (PE/DCF/财务报表) -> use `/fin-us-equity`
- A 股/港股分红分析 -> use `/fin-a-share` / `/fin-hk-stock`
- 财报 beat/miss / earnings season 分析 -> use `/fin-us-earnings`
- 宏观利率/GDP/CPI (非 yield spread 对比) -> use `/fin-macro`
- 加密货币 staking/yield farming -> use `/fin-crypto-defi`
- 期权/期货/可转债 -> use `/fin-derivatives`

## Tools & Parameters

### fin_stock

| Parameter  | Type   | Required | Format          | Default | Example               |
| ---------- | ------ | -------- | --------------- | ------- | --------------------- |
| symbol     | string | Yes      | US ticker       | —       | JNJ                   |
| endpoint   | string | Yes      | see table below | —       | fundamental/dividends |
| start_date | string | No       | YYYY-MM-DD      | —       | 2000-01-01            |
| end_date   | string | No       | YYYY-MM-DD      | —       | 2026-03-07            |
| limit      | number | No       | 1-5000          | 200     | 100                   |
| provider   | string | No       | yfinance        | auto    | yfinance              |

#### Endpoints

| endpoint                | Description                       | Example                                                                     |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `fundamental/dividends` | Full dividend history             | `fin_stock(symbol="JNJ", endpoint="fundamental/dividends", limit=100)`      |
| `fundamental/ratios`    | Payout ratio, dividend yield, ROE | `fin_stock(symbol="JNJ", endpoint="fundamental/ratios")`                    |
| `fundamental/cash`      | FCF for payout sustainability     | `fin_stock(symbol="JNJ", endpoint="fundamental/cash")`                      |
| `fundamental/metrics`   | Market cap, EV/EBITDA             | `fin_stock(symbol="JNJ", endpoint="fundamental/metrics")`                   |
| `us/income`             | EPS/Net income for coverage       | `fin_stock(symbol="JNJ", endpoint="us/income")`                             |
| `price/historical`      | Total return calculation          | `fin_stock(symbol="JNJ", endpoint="price/historical", provider="yfinance")` |
| `profile`               | Sector, industry classification   | `fin_stock(symbol="JNJ", endpoint="profile")`                               |

### fin_macro

| endpoint      | Description  | Example                             |
| ------------- | ------------ | ----------------------------------- |
| `treasury_us` | US 10Y yield | `fin_macro(endpoint="treasury_us")` |

## Dividend Classification System

| Tier              | Criteria                           | Examples                 |
| ----------------- | ---------------------------------- | ------------------------ |
| **Dividend King** | 50+ consecutive years of increases | JNJ, KO, PG, MMM, CL     |
| **Aristocrat**    | 25+ years in S&P 500               | ABBV, ABT, PEP, XOM, MCD |
| **Achiever**      | 10-24 consecutive years            | MSFT, AAPL, HD, V        |
| **Not qualified** | <10 years or any cut/freeze        | (evaluate case by case)  |

**Detection method:** `fundamental/dividends` with long history (limit=100+) -> calculate annual totals -> count consecutive YoY increases.

## Dividend Analysis Pattern

1. **Dividend history & classification** `fin_stock(endpoint="fundamental/dividends", symbol="JNJ", limit=100)` — Pull full dividend history
   - Calculate annual dividend totals for each calendar year
   - Count consecutive years of YoY increases -> classify as King/Aristocrat/Achiever
   - Calculate 5-year dividend CAGR = (Latest annual / 5-years-ago annual)^(1/5) - 1
   - ⚠️ If most recent annual dividend < prior year -> dividend was CUT, immediately flag as high risk
   - ⚠️ If dividend growth rate declining (CAGR last 3Y < CAGR last 5Y) -> growth deceleration

2. **Payout safety scoring** `fin_stock(endpoint="fundamental/ratios")` + `fin_stock(endpoint="fundamental/cash")` + `fin_stock(endpoint="us/income")` — Multi-factor safety assessment
   - **Earnings payout ratio**: Dividends per share / EPS (from ratios or compute from income)
   - **FCF payout ratio**: Total dividends / Free Cash Flow (from cash flow statement)
   - **FCF coverage**: FCF / Total dividends (inverse of FCF payout)
   - Safety score matrix:

   | Factor             | Green (Safe) | Yellow (Watch) | Red (At Risk) |
   | ------------------ | ------------ | -------------- | ------------- |
   | Earnings payout    | < 60%        | 60-80%         | > 80%         |
   | FCF payout         | < 70%        | 70-90%         | > 90%         |
   | FCF coverage       | > 1.5x       | 1.0-1.5x       | < 1.0x        |
   | Consecutive growth | 10+ years    | 5-9 years      | < 5 years     |
   | Dividend CAGR 5Y   | > 5%         | 2-5%           | < 2%          |
   - ⚠️ If earnings payout > 90% + FCF coverage < 1.0x -> **Yield Trap** alert: "High yield but dividend may be cut"
   - ⚠️ If FCF has been negative for 2+ quarters -> dividend funded by debt, unsustainable
   - 💡 Cross-validate: stable payout ratio + rising FCF = safest combination (growing into the payout)

3. **Yield vs Treasury spread** `fin_macro(endpoint="treasury_us")` — Compare dividend yield to risk-free rate
   - Spread = Dividend yield - 10Y Treasury yield
   - ⚠️ If spread < 0% (Treasury wins) -> bonds offer better risk-free income, dividend case weakens unless growth justifies
   - ⚠️ If spread > 2% -> attractive income premium, but verify it's not a yield trap (step 2)
   - 💡 Historical context: S&P 500 average dividend yield ~1.5%, 10Y Treasury averages ~3.5%. When spread is unusually wide, one of them is mispriced

4. **Total shareholder yield** `fin_stock(endpoint="fundamental/metrics")` + `fin_stock(endpoint="fundamental/cash")` — Dividend + Buyback
   - Buyback yield = (Share repurchases from cash flow) / Market cap
   - Total yield = Dividend yield + Buyback yield
   - ⚠️ If total yield > 6% but debt/equity rising -> shareholder returns funded by leverage, not operations
   - 💡 Mega-cap tech (AAPL/MSFT/META): buyback yield 3-5% dwarfs dividend yield <1%. Total yield is the true income metric

5. **Tax-adjusted yield (non-US investors)** — Calculate after-tax income
   - Default withholding: 30% on US dividends for non-US investors
   - Treaty rate (China-US): 10% (with W-8BEN filing)
   - After-tax yield = Gross yield \* (1 - withholding rate)
   - ⚠️ REITs (e.g., O, VNQ): dividends taxed as ordinary income even for US investors, higher effective tax
   - 💡 For Chinese investors: $1.00 dividend -> $0.70 after 30% withholding (no treaty) or $0.90 after 10% (with W-8BEN)

6. **Portfolio construction** — When user wants to build a dividend portfolio
   - **Sector diversification**: No more than 25% in any single sector
   - **Yield tier stratification**: Mix high-yield (4%+, slower growth) + growth-yield (1-3%, faster CAGR)
   - **Classic sectors**: Staples (PG/KO/PEP), Healthcare (JNJ/ABT/ABBV), Industrials (MMM/CAT), Utilities (SO/DUK)
   - **DRIP simulation**: Given initial amount + monthly contribution + portfolio yield + dividend CAGR -> compound over N years
     - Formula: FV = PV _ (1 + yield + growth)^N + PMT _ [((1 + r)^N - 1) / r] (simplified)
   - 💡 A 3.5% yield growing at 7% CAGR doubles income in ~10 years (Rule of 72)

## Data Notes

- **Dividend history**: `fundamental/dividends` provides ex-date + amount per share. Long history available for established payers (50+ years for Kings).
- **US quotes**: yfinance, ~15min delay. Use `provider="yfinance"` for `price/historical`.
- **Payout ratio**: Some providers pre-compute; otherwise calculate from `us/income` (EPS) and `fundamental/dividends`.
- **Aristocrat list**: No official list API. Classify by counting consecutive dividend increases from history data.
- **Ex-dividend dates**: Available in `fundamental/dividends` history but no forward calendar. Use most recent ex-date + quarterly cadence to estimate next.
- **Treasury yield**: `fin_macro(endpoint="treasury_us")` provides current and historical 10Y yield.
- **Buyback data**: Derived from `fundamental/cash` (financing activities) and `fundamental/metrics` (market cap). Not a direct buyback amount field.

## Response Guidelines

### Dollar Format

- Dividend per share: $1.24/quarter or $4.96/year (specify frequency)
- Yield: 3.42% (2 decimal places)
- Payout ratio: 58.3% (1 decimal place)
- Market cap: $420.5B (use $B/$M shorthand)
- Portfolio income: $3,800/year on $100K invested
- Tax withholding: $0.30 per $1.00 dividend (30% rate)

### Must Include

- Data cutoff date ("Data as of 2026-03-07")
- Consecutive years of dividend growth (the defining metric)
- Payout safety assessment (Green/Yellow/Red)
- Current yield vs 10Y Treasury yield spread
- Tax note for non-US investors when discussing income
- Dividend growth rate (5Y CAGR) alongside current yield

### Display Format

- Single stock dividend analysis -> sections: Classification | Safety Score | Yield vs Treasury | History Chart Description
- Dividend screener/comparison -> table with columns: Ticker | Yield | CAGR 5Y | Payout Ratio | Safety | Consecutive Years
- Portfolio construction -> sector allocation table + projected income schedule
- DRIP simulation -> year-by-year table showing: Year | Portfolio Value | Annual Dividend | Yield-on-Cost
- Yield trap warning -> prominent callout box with risk factors
- Always end with: "Key consideration for this dividend strategy is..."
