---
name: fin-a-dividend-king
description: "A-share dividend strategy — continuous dividend history, yield screening, payout safety, dividend trap detection, tax-aware income planning. Use when: user asks about high-dividend A-shares, dividend sustainability, income investing, dividend reinvestment, or dividend tax rules. NOT for: individual stock deep analysis (use fin-a-share), US/HK dividend stocks (use fin-us-dividend/fin-hk-dividend-harvest), index DCA timing (use fin-a-index-timer), factor screening (use fin-factor-screen)."
metadata:
  {
    "openclaw":
      { "emoji": "\ud83c\udf39", "requires": { "extensions": ["findoo-datahub-plugin"] } },
  }
---

# A-Share Dividend King Strategy

Use **fin_stock** and **fin_index** for systematic A-share dividend investing. Core logic: continuous dividends + sustainable payout + cash flow backing = true dividend king; high yield alone may be a trap.

## When to Use

- "A股哪些高股息股票" / "high dividend A-shares"
- "中国神华分红安全吗" / "is Shenhua's dividend safe"
- "红利ETF和自选组合哪个好" / "dividend ETF vs custom portfolio"
- "连续分红多少年" / "how many years of consecutive dividends"
- "每月投5000做红利策略" / "monthly 5000 RMB dividend strategy"
- "股息率4%以上的股票" / "stocks with yield above 4%"
- "红利税怎么算" / "how does dividend tax work"
- "高股息会不会是陷阱" / "could high yield be a trap"

## When NOT to Use

- 个股全景分析 (基本面/筹码/技术面) -> use `/fin-a-share`
- 美股股息策略 -> use `/fin-us-dividend`
- 港股高息策略 -> use `/fin-hk-dividend-harvest`
- 指数估值定投 -> use `/fin-a-index-timer`
- 量化多因子选股 -> use `/fin-factor-screen`
- 可转债/期货/期权 -> use `/fin-derivatives`
- 宏观经济数据 -> use `/fin-macro`
- 概念炒作周期 -> use `/fin-a-concept-cycle`

## Tools & Parameters

### fin_stock -- Dividend & Fundamental Data

| Parameter  | Type   | Required | Format          | Default | Example               |
| ---------- | ------ | -------- | --------------- | ------- | --------------------- |
| symbol     | string | Yes      | `{code}.SH/SZ`  | --      | 601088.SH             |
| endpoint   | string | Yes      | see table below | --      | fundamental/dividends |
| start_date | string | No       | YYYY-MM-DD      | --      | 2020-01-01            |
| end_date   | string | No       | YYYY-MM-DD      | --      | 2026-12-31            |
| limit      | number | No       | 1-5000          | 200     | 50                    |

#### Endpoints

| endpoint                | Description              | Example                                                                     |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `fundamental/dividends` | Dividend history         | `fin_stock(symbol="601088.SH", endpoint="fundamental/dividends", limit=20)` |
| `fundamental/ratios`    | Yield/PE/PB/ROE          | `fin_stock(symbol="601088.SH", endpoint="fundamental/ratios", limit=8)`     |
| `fundamental/income`    | Net income (payout calc) | `fin_stock(symbol="601088.SH", endpoint="fundamental/income", limit=8)`     |
| `fundamental/cash`      | OCF (sustainability)     | `fin_stock(symbol="601088.SH", endpoint="fundamental/cash", limit=8)`       |
| `fundamental/balance`   | Asset/liability check    | `fin_stock(symbol="601088.SH", endpoint="fundamental/balance", limit=4)`    |
| `price/historical`      | Total return tracking    | `fin_stock(symbol="601088.SH", endpoint="price/historical", limit=250)`     |
| `profile`               | Industry classification  | `fin_stock(symbol="601088.SH", endpoint="profile")`                         |

### fin_index -- Dividend Index Benchmarks

| Parameter | Type   | Required | Format         | Default | Example      |
| --------- | ------ | -------- | -------------- | ------- | ------------ |
| symbol    | string | Depends  | `XXXXXX.SH/SZ` | --      | 000922.SH    |
| endpoint  | string | Yes      | see table      | --      | constituents |
| limit     | number | No       | 1-5000         | 200     | 100          |

#### Endpoints

| endpoint           | Description                    | Example                                                            |
| ------------------ | ------------------------------ | ------------------------------------------------------------------ |
| `constituents`     | Index members (screening pool) | `fin_index(symbol="000922.SH", endpoint="constituents")`           |
| `daily_basic`      | Index PE/PB valuation          | `fin_index(symbol="000922.SH", endpoint="daily_basic", limit=250)` |
| `price/historical` | Index price history            | `fin_index(symbol="000922.SH", endpoint="price/historical")`       |

**Key dividend indices:**

- `000922.SH` -- CSI Dividend Index (中证红利)
- `000015.SH` -- Dividend Index (上证红利)
- `399324.SZ` -- Shenzhen Dividend Price Index (深证红利)

## Dividend Analysis Pattern

1. **Dividend Continuity Check** `fin_stock(fundamental/dividends, limit=15)` -- Establish track record
   - Count consecutive years with cash dividend > 0
   - Calculate average annual dividend per share and growth rate
   - Check for irregular patterns (special dividends, stock dividends only)
   - > =5 consecutive years = stable; >=10 years = king; <3 years = unreliable
   - Payout frequency: most A-shares pay annually (Apr-Jul); some pay semi-annually

2. **Yield Validation** `fin_stock(fundamental/ratios, limit=8)` -- Current yield vs history
   - Current dividend yield (dv_ratio field) vs 5-year average
   - > =4% = attractive; >=6% = unusually high (verify sustainability)
   - Compare PE/PB to determine if high yield comes from price drop (may be value trap)
   - <=2% = below market, not suitable for income strategy
   - ROE should be >8% for sustainable dividends

3. **Payout Safety** `fin_stock(fundamental/income, limit=8)` + `fin_stock(fundamental/cash, limit=8)` -- Can they keep paying?
   - Payout ratio = total dividend / net income
   - <60% = very safe; 60-70% = safe; 70-85% = elevated; >85% = at risk of cut
   - OCF / total dividend > 1.5x = cash flow backed; <1.0x = borrowing to pay dividends
   - Net income trend: declining 2+ quarters = future payout at risk
   - Free cash flow (OCF - CapEx) should cover dividends

4. **Dividend Trap Detection** -- Cross-validate steps 1-3
   - Trap Signal 1: yield >8% + declining revenue 2 quarters = likely cut next year
   - Trap Signal 2: payout ratio >90% + OCF/dividend <1.0 = unsustainable
   - Trap Signal 3: one-time special dividend inflating yield (check dividend history for irregularity)
   - Trap Signal 4: high yield from price crash (PE dropping) not from growing dividends
   - Safe Signal: yield 4-6% + payout <65% + OCF coverage >2x + stable/growing earnings = genuine king

5. **Industry Layer** `fin_stock(profile)` -- Sector-specific dividend characteristics
   - Utilities (power/water): most stable, 4-5% yield, low growth, quasi-bond
   - Banks: highest yield (5-7%), very low payout ratio (25-35%), safe but zero growth
   - Energy (coal/oil): cyclical, current high yield may not persist through down-cycle
   - Consumer staples: moderate yield (2-4%), but dividend growth 8-12% p.a.
   - Real estate: historically high yield, but sector risk post-2022 makes sustainability questionable
   - Telecom (China Mobile/Unicom/Telecom): state-owned, stable 4-5%, improving payout policy

6. **Dividend Index Benchmark** `fin_index(daily_basic, symbol=000922.SH, limit=250)` -- Is the strategy cheap?
   - CSI Dividend Index current PE/PB vs 10-year percentile
   - PE <30% percentile = dividend stocks are cheap (good entry)
   - PE >70% percentile = dividend premium exhausted, reduce exposure
   - Compare individual stock yield to CSI Dividend Index yield

## Dividend Tax Rules (A-Share)

| Holding Period   | Tax Rate | Net Yield (on 5% gross) |
| ---------------- | -------- | ----------------------- |
| < 1 month        | 20%      | 4.0%                    |
| 1 month - 1 year | 10%      | 4.5%                    |
| > 1 year         | 0%       | 5.0%                    |

**Strategy implication:** Hold dividend stocks > 1 year for tax-free dividends. Short-term traders lose 20% of dividend income to tax.

## Dividend Reinvestment Compound Model

When user asks about long-term wealth building:

```
Given: monthly investment M, average yield Y, dividend growth rate G
Year N total = M * 12 * N * (1 + Y * (1+G)^(N/2))  (simplified)

Example: M=5000, Y=5%, G=3%, N=20
  Principal: 5000 * 12 * 20 = 1,200,000
  With DRIP compound: ~1,980,000 (estimated)
  Dividend income Year 20: ~99,000/year (~8,250/month passive income)
```

Show both with and without dividend reinvestment to demonstrate compounding power.

## Data Notes

- **Dividend data**: Tushare, updated after annual/interim report disclosure (Apr-Aug main window)
- **Dividend yield**: calculated on trailing 12-month dividends; forward yield needs manual estimate
- **Payout ratio**: use annual data only (quarterly dividends rare in A-shares)
- **Ex-dividend dates**: extractable from `fundamental/dividends` record_date/ex_date fields
- **A-share specifics**: most companies pay once per year; some SOEs moving to semi-annual
- **Data lag**: dividend announcements may lag actual board decision by 1-2 weeks

## Response Guidelines

### Number Format

- Dividend yield: 5.23% (2 decimal places, always with %)
- Payout ratio: 62.5% (1 decimal place)
- Dividend per share: 1.85 RMB/share
- Market cap / revenue: > 1 yi use "yi RMB", < 1 yi use "wan RMB"
- Consecutive years: "10 consecutive years" (integer)
- OCF coverage: 2.3x (1 decimal place)

### Must Include

- Data cutoff date
- Consecutive dividend years count
- Payout ratio with safety assessment
- OCF coverage ratio
- Dividend tax impact based on holding period
- Any trap warning signals detected

### Display Format

- Single stock dividend analysis: narrative with key metrics bolded
- Multi-stock dividend screening: table (columns: stock / yield / consecutive years / payout ratio / OCF coverage / safety score)
- Dividend history: summarize trend direction + key changes, don't list every year
- Always end with: holding period tax reminder + ex-dividend date if approaching
