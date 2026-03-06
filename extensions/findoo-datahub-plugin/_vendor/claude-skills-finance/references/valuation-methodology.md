# Valuation Methodology Guide

Comprehensive reference for business valuation approaches including DCF analysis, comparable company analysis, and precedent transactions.

## 1. Discounted Cash Flow (DCF) Methodology

### Overview

DCF is an intrinsic valuation method that estimates the present value of a company's expected future free cash flows, discounted at an appropriate rate reflecting the risk of those cash flows.

**Core Principle:** The value of a business equals the present value of all future cash flows it will generate.

**Formula:**

```
Enterprise Value = Sum of [FCF_t / (1 + WACC)^t] + Terminal Value / (1 + WACC)^n
```

Where:

- FCF_t = Free Cash Flow in year t
- WACC = Weighted Average Cost of Capital
- n = number of projection years

### Step 1: Historical Analysis

Before projecting, analyze 3-5 years of historical financials:

- **Revenue growth rates** - Identify organic vs acquisition-driven growth
- **Margin trends** - Gross, operating, and net margin trajectories
- **Capital intensity** - CapEx as % of revenue
- **Working capital** - Cash conversion cycle trends
- **Free cash flow conversion** - FCF / Net Income ratio

### Step 2: Revenue Projections

**Approaches:**

1. **Top-down:** Market size x Market share x Pricing
2. **Bottom-up:** Units x Price, or Customers x ARPU
3. **Growth rate extrapolation:** Historical growth with decay

**Revenue Projection Best Practices:**

- Use 5-7 year explicit projection period
- Growth should converge toward GDP growth by terminal year
- Support assumptions with market data and management guidance
- Model revenue by segment/product line when possible

### Step 3: Free Cash Flow Calculation

**Unlevered Free Cash Flow (UFCF):**

```
UFCF = EBIT x (1 - Tax Rate)
     + Depreciation & Amortization
     - Capital Expenditures
     - Changes in Net Working Capital
```

**Key Drivers:**

- Operating margin trajectory
- CapEx as % of revenue (maintenance vs growth)
- Working capital requirements (DSO, DIO, DPO)
- Tax rate (effective vs marginal)

### Step 4: WACC Calculation

**Weighted Average Cost of Capital:**

```
WACC = (E/V x Re) + (D/V x Rd x (1 - T))
```

Where:

- E/V = Equity weight (market value)
- D/V = Debt weight (market value)
- Re = Cost of equity
- Rd = Cost of debt (pre-tax)
- T = Marginal tax rate

#### Cost of Equity (CAPM)

```
Re = Rf + Beta x (Rm - Rf) + Size Premium + Company-Specific Risk
```

| Component                 | Description                        | Typical Range |
| ------------------------- | ---------------------------------- | ------------- |
| Risk-Free Rate (Rf)       | 10-year Treasury yield             | 3.5% - 5.0%   |
| Equity Risk Premium (ERP) | Market return above risk-free      | 5.0% - 7.0%   |
| Beta                      | Systematic risk relative to market | 0.5 - 2.0     |
| Size Premium              | Small-cap additional risk          | 0% - 5%       |
| Company-Specific Risk     | Unique risk factors                | 0% - 5%       |

**Beta Estimation:**

- Use 2-5 year weekly returns against broad market index
- Unlevered betas for comparability, then re-lever to target capital structure
- Consider industry median beta for stability

#### Cost of Debt

```
Rd = Yield on comparable-maturity corporate bonds
   OR
Rd = Risk-Free Rate + Credit Spread
```

**Credit Spread by Rating:**
| Rating | Typical Spread |
|--------|---------------|
| AAA | 0.5% - 1.0% |
| AA | 1.0% - 1.5% |
| A | 1.5% - 2.0% |
| BBB | 2.0% - 3.0% |
| BB | 3.0% - 5.0% |
| B | 5.0% - 8.0% |

### Step 5: Terminal Value

Terminal value typically represents 60-80% of total enterprise value. Use two methods and cross-check.

#### Perpetuity Growth Method

```
TV = FCF_n x (1 + g) / (WACC - g)
```

Where g = terminal growth rate (typically 2.0% - 3.0%, should not exceed long-term GDP growth)

**Sensitivity:** Terminal value is highly sensitive to g. A 0.5% change in g can move enterprise value by 15-25%.

#### Exit Multiple Method

```
TV = Terminal Year EBITDA x Exit EV/EBITDA Multiple
```

**Exit Multiple Selection:**

- Use current trading multiples of comparable companies
- Consider whether current multiples are at historical highs/lows
- Apply a discount for lack of marketability if private

**Cross-Check:** Both methods should yield similar results. Large discrepancies signal inconsistent assumptions.

### Step 6: Enterprise to Equity Bridge

```
Enterprise Value
- Net Debt (Total Debt - Cash)
- Minority Interest
- Preferred Equity
+ Equity Method Investments
= Equity Value

Equity Value / Diluted Shares Outstanding = Value Per Share
```

### Step 7: Sensitivity Analysis

Always present results as a range, not a single point estimate.

**Standard Sensitivity Tables:**

1. WACC vs Terminal Growth Rate
2. WACC vs Exit Multiple
3. Revenue Growth vs Operating Margin

**Scenario Analysis:**

- Base case: Management guidance / consensus estimates
- Bull case: Upside scenario with faster growth or margin expansion
- Bear case: Downside scenario with slower growth or margin compression

## 2. Comparable Company Analysis

### Methodology

1. **Select peer group** - Similar size, industry, growth profile, and margins
2. **Calculate trading multiples** for each peer
3. **Determine appropriate multiple range**
4. **Apply to target company's metrics**

### Common Multiples

| Multiple   | When to Use                                 |
| ---------- | ------------------------------------------- |
| EV/Revenue | Pre-profit companies, high-growth tech      |
| EV/EBITDA  | Most common for mature companies            |
| EV/EBIT    | When D&A differs significantly across peers |
| P/E        | Stable earnings, financial services         |
| P/B        | Banks, insurance, asset-heavy industries    |
| EV/FCF     | Capital-light businesses with clean FCF     |

### Peer Selection Criteria

- **Industry:** Same or closely adjacent sectors
- **Size:** Within 0.5x to 2x of target revenue/market cap
- **Geography:** Same primary markets
- **Growth profile:** Similar revenue growth rates (within 5-10%)
- **Margin profile:** Similar operating margin structure
- **Business model:** Comparable revenue mix and customer base

### Premium/Discount Adjustments

| Factor          | Adjustment                           |
| --------------- | ------------------------------------ |
| Higher growth   | Premium of 1-3x on EV/EBITDA         |
| Lower margins   | Discount of 1-2x                     |
| Smaller scale   | Discount of 10-20%                   |
| Private company | Discount of 15-30% (illiquidity)     |
| Control premium | Premium of 20-40% (for acquisitions) |

## 3. Precedent Transaction Analysis

### Methodology

1. **Identify comparable transactions** in same industry
2. **Calculate transaction multiples** (EV/Revenue, EV/EBITDA)
3. **Adjust for market conditions** and deal-specific factors
4. **Apply adjusted multiples** to target

### Key Considerations

- Transactions include control premiums (typically 20-40%)
- Market conditions at time of deal affect multiples
- Strategic vs financial buyer valuations differ
- Consider synergy expectations embedded in price
- More recent transactions carry greater relevance

## 4. Valuation Framework Selection

| Situation               | Primary Method                    | Secondary Method           |
| ----------------------- | --------------------------------- | -------------------------- |
| Profitable, stable      | DCF                               | Comparable companies       |
| High growth, pre-profit | Comparable companies (EV/Revenue) | DCF with scenario analysis |
| M&A target              | Precedent transactions            | DCF                        |
| Asset-heavy, cyclical   | Asset-based valuation             | Normalized DCF             |
| Financial institution   | Dividend discount model           | P/B, P/E comps             |
| Distressed              | Liquidation value                 | Restructured DCF           |

## 5. Common Pitfalls

1. **Hockey stick projections** - Unrealistic growth acceleration in later years
2. **Terminal value dominance** - If TV > 80% of EV, shorten projection period or question assumptions
3. **Circular references** - WACC depends on equity value which depends on WACC
4. **Ignoring working capital** - Can significantly affect FCF
5. **Single-point estimates** - Always present as a range
6. **Stale comparables** - Market conditions change; update regularly
7. **Confirmation bias** - Don't work backward from a desired conclusion
8. **Ignoring dilution** - Use fully diluted shares (treasury stock method for options)
