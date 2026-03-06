---
name: financial-analyst
description: Performs financial ratio analysis, DCF valuation, budget variance analysis, and rolling forecast construction for strategic decision-making
---

# Financial Analyst Skill

## Overview

Production-ready financial analysis toolkit providing ratio analysis, DCF valuation, budget variance analysis, and rolling forecast construction. Designed for financial analysts with 3-6 years experience performing financial modeling, forecasting & budgeting, management reporting, business performance analysis, and investment analysis.

## 5-Phase Workflow

### Phase 1: Scoping

- Define analysis objectives and stakeholder requirements
- Identify data sources and time periods
- Establish materiality thresholds and accuracy targets
- Select appropriate analytical frameworks

### Phase 2: Data Analysis & Modeling

- Collect and validate financial data (income statement, balance sheet, cash flow)
- Calculate financial ratios across 5 categories (profitability, liquidity, leverage, efficiency, valuation)
- Build DCF models with WACC and terminal value calculations
- Construct budget variance analyses with favorable/unfavorable classification
- Develop driver-based forecasts with scenario modeling

### Phase 3: Insight Generation

- Interpret ratio trends and benchmark against industry standards
- Identify material variances and root causes
- Assess valuation ranges through sensitivity analysis
- Evaluate forecast scenarios (base/bull/bear) for decision support

### Phase 4: Reporting

- Generate executive summaries with key findings
- Produce detailed variance reports by department and category
- Deliver DCF valuation reports with sensitivity tables
- Present rolling forecasts with trend analysis

### Phase 5: Follow-up

- Track forecast accuracy (target: +/-5% revenue, +/-3% expenses)
- Monitor report delivery timeliness (target: 100% on time)
- Update models with actuals as they become available
- Refine assumptions based on variance analysis

## Tools

### 1. Ratio Calculator (`scripts/ratio_calculator.py`)

Calculate and interpret financial ratios from financial statement data.

**Ratio Categories:**

- **Profitability:** ROE, ROA, Gross Margin, Operating Margin, Net Margin
- **Liquidity:** Current Ratio, Quick Ratio, Cash Ratio
- **Leverage:** Debt-to-Equity, Interest Coverage, DSCR
- **Efficiency:** Asset Turnover, Inventory Turnover, Receivables Turnover, DSO
- **Valuation:** P/E, P/B, P/S, EV/EBITDA, PEG Ratio

```bash
python scripts/ratio_calculator.py sample_financial_data.json
python scripts/ratio_calculator.py sample_financial_data.json --format json
python scripts/ratio_calculator.py sample_financial_data.json --category profitability
```

### 2. DCF Valuation (`scripts/dcf_valuation.py`)

Discounted Cash Flow enterprise and equity valuation with sensitivity analysis.

**Features:**

- WACC calculation via CAPM
- Revenue and free cash flow projections (5-year default)
- Terminal value via perpetuity growth and exit multiple methods
- Enterprise value and equity value derivation
- Two-way sensitivity analysis (discount rate vs growth rate)

```bash
python scripts/dcf_valuation.py valuation_data.json
python scripts/dcf_valuation.py valuation_data.json --format json
python scripts/dcf_valuation.py valuation_data.json --projection-years 7
```

### 3. Budget Variance Analyzer (`scripts/budget_variance_analyzer.py`)

Analyze actual vs budget vs prior year performance with materiality filtering.

**Features:**

- Dollar and percentage variance calculation
- Materiality threshold filtering (default: 10% or $50K)
- Favorable/unfavorable classification with revenue/expense logic
- Department and category breakdown
- Executive summary generation

```bash
python scripts/budget_variance_analyzer.py budget_data.json
python scripts/budget_variance_analyzer.py budget_data.json --format json
python scripts/budget_variance_analyzer.py budget_data.json --threshold-pct 5 --threshold-amt 25000
```

### 4. Forecast Builder (`scripts/forecast_builder.py`)

Driver-based revenue forecasting with rolling cash flow projection and scenario modeling.

**Features:**

- Driver-based revenue forecast model
- 13-week rolling cash flow projection
- Scenario modeling (base/bull/bear cases)
- Trend analysis using simple linear regression (standard library)

```bash
python scripts/forecast_builder.py forecast_data.json
python scripts/forecast_builder.py forecast_data.json --format json
python scripts/forecast_builder.py forecast_data.json --scenarios base,bull,bear
```

## Knowledge Bases

| Reference                                  | Purpose                                               |
| ------------------------------------------ | ----------------------------------------------------- |
| `references/financial-ratios-guide.md`     | Ratio formulas, interpretation, industry benchmarks   |
| `references/valuation-methodology.md`      | DCF methodology, WACC, terminal value, comps          |
| `references/forecasting-best-practices.md` | Driver-based forecasting, rolling forecasts, accuracy |

## Templates

| Template                             | Purpose                          |
| ------------------------------------ | -------------------------------- |
| `assets/variance_report_template.md` | Budget variance report template  |
| `assets/dcf_analysis_template.md`    | DCF valuation analysis template  |
| `assets/forecast_report_template.md` | Revenue forecast report template |

## Industry Adaptations

### SaaS

- Key metrics: MRR, ARR, CAC, LTV, Churn Rate, Net Revenue Retention
- Revenue recognition: subscription-based, deferred revenue tracking
- Unit economics: CAC payback period, LTV/CAC ratio
- Cohort analysis for retention and expansion revenue

### Retail

- Key metrics: Same-store sales, Revenue per square foot, Inventory turnover
- Seasonal adjustment factors in forecasting
- Gross margin analysis by product category
- Working capital cycle optimization

### Manufacturing

- Key metrics: Gross margin by product line, Capacity utilization, COGS breakdown
- Bill of materials cost analysis
- Absorption vs variable costing impact
- Capital expenditure planning and ROI

### Financial Services

- Key metrics: Net Interest Margin, Efficiency Ratio, ROA, Tier 1 Capital
- Regulatory capital requirements
- Credit loss provisioning and reserves
- Fee income analysis and diversification

### Healthcare

- Key metrics: Revenue per patient, Payer mix, Days in A/R, Operating margin
- Reimbursement rate analysis by payer
- Case mix index impact on revenue
- Compliance cost allocation

## Key Metrics & Targets

| Metric                       | Target                       |
| ---------------------------- | ---------------------------- |
| Forecast accuracy (revenue)  | +/-5%                        |
| Forecast accuracy (expenses) | +/-3%                        |
| Report delivery              | 100% on time                 |
| Model documentation          | Complete for all assumptions |
| Variance explanation         | 100% of material variances   |

## Input Data Format

All scripts accept JSON input files. See `assets/sample_financial_data.json` for the complete input schema covering all four tools.

## Dependencies

**None** - All scripts use Python standard library only (`math`, `statistics`, `json`, `argparse`, `datetime`). No numpy, pandas, or scipy required.
