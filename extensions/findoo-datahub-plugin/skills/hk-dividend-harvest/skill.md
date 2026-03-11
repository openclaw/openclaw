---
name: fin-hk-dividend-harvest
description: "HK dividend strategy — tax-adjusted yield (H-share 20%/red-chip 10%/foreign 0%), dividend safety score, liquidity filter, yield trap detection. Use when: user wants HK high-yield stocks, dividend income strategy, after-tax yield comparison, or asks if a HK stock's dividend is sustainable. NOT for: individual HK stock analysis (use fin-hk-stock), A-share dividends (use fin-a-share), REITs/ETFs (use fin-etf-fund), HSI valuation (use fin-hk-hsi-pulse)."
metadata:
  { "openclaw": { "emoji": "\U0001F4B0", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# HK Dividend Harvest

Screen and evaluate Hong Kong high-dividend stocks with **tax-adjusted yields**. HK's unique multi-tier dividend tax (H-share 20%, red-chip 10%, foreign 0%) means headline yield ≠ real yield. This skill ensures investors compare after-tax returns and avoid liquidity traps.

## When to Use

- "港股高息股推荐" / "HK high-yield stock picks"
- "想买港股收息" / "HK dividend income strategy"
- "中移动和工行收息哪个好" / "China Mobile vs ICBC for dividends"
- "这只股 yield 9% 靠谱吗" / "Is this 9% yield sustainable?"
- "港股股息税怎么算" / "HK dividend tax explained"
- "港股收息组合" / "HK dividend portfolio"
- "港股高息陷阱" / "HK yield trap"

## When NOT to Use

- 单只港股全景分析 (财报/技术面/AH溢价) → use `/fin-hk-stock`
- A 股红利策略 / A 股股息 → use `/fin-a-share`
- 港股 REITs/ETF 分析 → use `/fin-etf-fund`
- 恒指估值判断 → use `/fin-hk-hsi-pulse`
- 美股股息 → use `/fin-us-equity`
- 港股流动性专项检查 → use `/fin-hk-stock` (Liquidity Trap Detection)
- ETF/基金分红 → use `/fin-etf-fund`

## Tools & Parameters

### fin_stock — Individual stock data

| Parameter  | Type   | Required | Format        | Default | Example            |
| ---------- | ------ | -------- | ------------- | ------- | ------------------ |
| symbol     | string | Yes      | 5-digit + .HK | —       | 00941.HK           |
| endpoint   | string | Yes      | see below     | —       | fundamental/ratios |
| start_date | string | No       | YYYY-MM-DD    | —       | 2023-01-01         |
| end_date   | string | No       | YYYY-MM-DD    | —       | 2026-03-07         |
| limit      | number | No       | 1-5000        | 200     | 20                 |

#### Endpoints

| endpoint                | Description              | Example                                                               |
| ----------------------- | ------------------------ | --------------------------------------------------------------------- |
| `fundamental/ratios`    | PE/PB/dividend yield     | `fin_stock(symbol="00941.HK", endpoint="fundamental/ratios")`         |
| `fundamental/dividends` | Dividend history         | `fin_stock(symbol="00941.HK", endpoint="fundamental/dividends")`      |
| `hk/income`             | IFRS P&L (payout calc)   | `fin_stock(symbol="00941.HK", endpoint="hk/income")`                  |
| `hk/cashflow`           | OCF (sustainability)     | `fin_stock(symbol="00941.HK", endpoint="hk/cashflow")`                |
| `price/historical`      | Price + volume           | `fin_stock(symbol="00941.HK", endpoint="price/historical", limit=60)` |
| `profile`               | Company info + structure | `fin_stock(symbol="00941.HK", endpoint="profile")`                    |

### Auxiliary

| Tool / Endpoint               | Use Case                      | Example                                          |
| ----------------------------- | ----------------------------- | ------------------------------------------------ |
| `fin_macro(endpoint="hibor")` | Risk-free rate (yield spread) | `fin_macro(endpoint="hibor")`                    |
| `fin_data_regime`             | Market regime overlay         | `fin_data_regime(symbol="HSI", market="equity")` |

## HK Dividend Tax Structure

**This is the core knowledge edge.** Always compute tax-adjusted yield before comparison.

| Company Structure                            | Tax Rate | Examples                                                  | Detection Method                               |
| -------------------------------------------- | -------- | --------------------------------------------------------- | ---------------------------------------------- |
| **H-share** (mainland-incorporated)          | 20%      | ICBC (01398), PetroChina (00857), BYD (01211)             | `profile` → incorporated in mainland China     |
| **Red-chip** (HK-incorporated, mainland ops) | 10%      | China Mobile (00941), CNOOC (00883), China Unicom (00762) | `profile` → HK incorporated, mainland revenue  |
| **HK-local / Foreign**                       | 0%       | HSBC (00005), AIA (01299), CLP (00002)                    | `profile` → HK/foreign incorporated + operated |
| **Stock Connect (southbound individual)**    | 20%      | Applies to all HK stocks via Connect                      | Channel-based, not stock-based                 |
| **Stock Connect (southbound institution)**   | 10%      | Applies to all HK stocks via Connect                      | Channel-based                                  |

Formula: `after_tax_yield = headline_yield * (1 - tax_rate)`

Example: ICBC H-share headline yield 7.2% → after-tax 5.76%; China Mobile red-chip 6.8% → after-tax 6.12%. Same ballpark headline, but red-chip nets 0.36% more annually.

## Dividend Harvest Analysis Pattern

1. **Headline yield screening** `fin_stock(endpoint="fundamental/ratios")` — Get dividend yield, PE, PB
   - Target: headline DY > 5% (to clear tax drag and still beat deposits)
   - ⚠️ If DY > 8% → high probability of yield trap, proceed to step 5 immediately
   - 💡 PE <12x is a basic margin of safety; PE >15x + high DY = likely one-time special dividend

2. **Liquidity gate** `fin_stock(endpoint="price/historical", limit=60)` — Compute avg daily turnover (volume \* close)
   - **MUST run before any buy recommendation**
   - ⚠️ Daily turnover < 10M HKD → **REJECT** — liquidity trap, "easy to buy, impossible to exit"
   - ⚠️ Daily turnover 10-50M HKD → **WARN** — limited liquidity, position sizing critical
   - Daily turnover > 50M HKD → PASS
   - 💡 Connect eligibility (`fin_market(endpoint="flow/hs_const")`) adds southbound liquidity buffer

3. **Tax classification** `fin_stock(endpoint="profile")` — Determine company structure → tax rate
   - Map incorporation + revenue geography to H-share/red-chip/local categories
   - Compute after-tax yield = headline \* (1 - tax_rate)
   - ⚠️ If user invests via Stock Connect → always apply 20% regardless of company structure
   - 💡 For same headline yield, prefer red-chip (10%) over H-share (20%) = 0.6-0.7% annual edge

4. **Dividend safety assessment** — Multi-factor sustainability check
   a. **Payout ratio** `fin_stock(endpoint="hk/income")` — dividend / net income
   - ⚠️ Payout ratio > 90% → unsustainable unless utility/REIT with guaranteed cash flow
   - Healthy range: 30-70%
     b. **Cash flow cover** `fin_stock(endpoint="hk/cashflow")` — OCF / total dividends paid
   - ⚠️ OCF/Dividend < 1.2x → dividends funded by debt or asset sales, not operations
   - Healthy: OCF/Dividend > 1.5x
     c. **Earnings stability** `fin_stock(endpoint="hk/income", limit=12)` — 3-year net income trend
   - ⚠️ 2+ consecutive years of declining net income → dividend cut risk elevated
     d. **Dividend history** `fin_stock(endpoint="fundamental/dividends")` — Continuity
   - Consecutive years of payment ≥ 5 years → stable payer
   - ⚠️ Skipped a year in past 5 years → unreliable, apply discount

   **Dividend Safety Score**:
   | Factor | Green | Yellow | Red |
   | --------------------------- | ------------ | --------------- | ---------------- |
   | Payout ratio | 30-70% | 70-90% | >90% or negative |
   | OCF/Dividend | >1.5x | 1.2-1.5x | <1.2x |
   | Earnings trend (3Y) | Stable/growing| Flat | Declining |
   | Consecutive dividend years | ≥5 years | 3-4 years | <3 years |

   Score: 4 Green = **Safe** | 3+ Green = **Adequate** | Any Red = **At Risk** | 2+ Red = **Dangerous**

5. **Yield trap detection** — When DY looks too good to be true
   - ⚠️ DY > 8% + payout > 90% + earnings declining → **YIELD TRAP** — dividend cut is imminent
   - ⚠️ DY > 10% + daily turnover < 30M HKD → **ILLIQUID YIELD TRAP** — worst combination
   - ⚠️ Special/one-time dividend inflating trailing yield → next year's yield will be much lower
   - 💡 Check `fundamental/dividends` for consistency: if latest dividend >> historical average, it's likely non-recurring

6. **Yield spread vs HIBOR** `fin_macro(endpoint="hibor")` — Is dividend income attractive vs risk-free?
   - Yield spread = after-tax DY - HIBOR 3M
   - ⚠️ If spread < 1.5% → deposit rates nearly as good, equity risk not compensated
   - 💡 Falling HIBOR (Fed cutting) → yield spread widens → dividend stocks re-rate upward (dual catalyst: yield + valuation)
   - Historical avg spread ~2.5-3.5%

7. **Cross-reference signals**
   - 💡 Combine with `/fin-hk-hsi-pulse`: if HSI PE at deep value + high-yield stocks passing all filters → strongest buy signal
   - 💡 Combine with `/fin-macro` (hibor): falling HIBOR = positive for dividend spread
   - 💡 AH-listed stocks: compare A-share DY (tax-free if held >1Y) vs H-share DY (taxed) → sometimes A-side is better for dividends

## Classic HK Dividend Stocks (Reference)

| Stock           | Code     | Structure | Tax Rate | Typical DY | Sector      |
| --------------- | -------- | --------- | -------- | ---------- | ----------- |
| China Mobile    | 00941.HK | Red-chip  | 10%      | 6-7%       | Telecom     |
| CNOOC           | 00883.HK | Red-chip  | 10%      | 7-9%       | Energy      |
| ICBC-H          | 01398.HK | H-share   | 20%      | 7-8%       | Bank        |
| CCB-H           | 00939.HK | H-share   | 20%      | 7-8%       | Bank        |
| BOC-H           | 03988.HK | H-share   | 20%      | 6-7%       | Bank        |
| CLP Holdings    | 00002.HK | HK-local  | 0%       | 4-5%       | Utility     |
| HK Electric     | 02638.HK | HK-local  | 0%       | 5-6%       | Utility     |
| Link REIT       | 00823.HK | Trust     | 0%       | 5-7%       | REIT        |
| China Shenhua-H | 01088.HK | H-share   | 20%      | 8-10%      | Coal/Energy |
| HSBC            | 00005.HK | Foreign   | 0%       | 4-5%       | Bank        |

⚠️ This table is for reference only. Always verify current yield and safety score with live data.

## Data Notes

- **Dividend yield (fundamental/ratios)**: yfinance, trailing 12M, ~15min delay during trading
- **HK financials (hk/income, hk/cashflow)**: tushare, semi-annual (interim Aug, final Mar-Apr), IFRS
- **Dividend history (fundamental/dividends)**: yfinance, may miss very recent declarations
- **Profile**: yfinance, static data — company structure classification requires manual interpretation
- **Tax rate classification**: approximation based on profile; edge cases exist (e.g., some red-chips have mainland subsidiaries paying H-share rates on portion of dividends)
- **Missing**: ex-dividend calendar (precise ex-date/payment date), precise company structure database (H-share/red-chip labels not in any endpoint — inferred from profile)

## Response Guidelines

### Number Format

- Dividend yield: 6.80% (2 decimals, always %)
- After-tax yield: 5.44% (2 decimals, explicitly labeled "tax-adjusted" or "after-tax")
- Tax rate: 20% / 10% / 0% (always state company structure reason)
- Payout ratio: 65.3% (1 decimal)
- OCF/Dividend: 1.8x (1 decimal + "x")
- Daily turnover: HK$85M / HK$1.2B (use M/B with HK$ prefix)
- Stock price: HK$72.50 (2 decimals with HK$ prefix)
- Yield spread: 2.3 ppt (percentage points)

### Must Include

- **Tax-adjusted yield** for every stock mentioned (never show only headline yield)
- Company structure classification (H-share/red-chip/local) with tax rate
- Liquidity status (daily turnover in HKD)
- Dividend safety score (Green/Yellow/Red per factor)
- Data cutoff date
- If user invests via Stock Connect: remind them of 20% flat rate

### Display Format

- Single stock: narrative with key metrics bolded, safety scorecard table
- Multi-stock comparison: table with columns: Stock / Code / Structure / Tax% / Headline DY / After-Tax DY / Safety Score / Liquidity
- Always sort by after-tax yield (not headline) — this is the core value proposition
- Yield trap alerts: use bold + warning language, place before any positive commentary
- End with yield spread vs HIBOR assessment and rate cycle positioning
