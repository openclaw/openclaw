# Forecasting Best Practices

Comprehensive reference for financial forecasting including driver-based models, rolling forecasts, accuracy improvement techniques, and scenario planning.

## 1. Driver-Based Forecasting

### Overview

Driver-based forecasting models financial outcomes based on key business drivers rather than extrapolating from historical trends alone. This approach creates more transparent, actionable, and accurate forecasts.

### Identifying Key Drivers

**Revenue Drivers:**

| Business Model        | Primary Drivers                      |
| --------------------- | ------------------------------------ |
| SaaS/Subscription     | Customers x ARPU x Retention Rate    |
| E-commerce            | Visitors x Conversion Rate x AOV     |
| Manufacturing         | Units x Price per Unit               |
| Professional Services | Headcount x Utilization x Bill Rate  |
| Retail                | Stores x Revenue per Store (or sqft) |
| Marketplace           | GMV x Take Rate                      |

**Cost Drivers:**

| Category          | Common Drivers                                         |
| ----------------- | ------------------------------------------------------ |
| COGS              | Revenue x (1 - Gross Margin) or Units x Unit Cost      |
| Headcount Costs   | Employees x Average Compensation x (1 + Benefits Rate) |
| Sales & Marketing | Revenue x S&M % or CAC x New Customers                 |
| R&D               | Engineering Headcount x Avg Salary                     |
| G&A               | Headcount-based + fixed costs                          |
| CapEx             | Revenue x CapEx Intensity or Project-based             |

### Building a Driver-Based Model

**Step 1: Map the value chain**

- Revenue = f(volume drivers, pricing drivers, mix drivers)
- Costs = f(variable drivers, fixed components, step functions)

**Step 2: Establish driver relationships**

- Linear: Revenue = Units x Price
- Non-linear: Revenue = Base x (1 + Growth Rate)^t
- Step function: Facilities costs that jump at capacity thresholds

**Step 3: Validate driver assumptions**

- Compare driver values to historical actuals
- Benchmark against industry data
- Stress-test extreme values

**Step 4: Build sensitivity**

- Identify which drivers have the largest impact on output
- Quantify the range of reasonable values for each driver
- Create scenario combinations

### Driver Sensitivity Matrix

Rank drivers by impact and uncertainty:

|                      | High Impact                           | Low Impact                   |
| -------------------- | ------------------------------------- | ---------------------------- |
| **High Uncertainty** | Model these carefully, run scenarios  | Monitor but don't over-model |
| **Low Uncertainty**  | Get these right; high accuracy needed | Use simple assumptions       |

## 2. Rolling Forecasts

### What Is a Rolling Forecast?

A rolling forecast continuously extends the forecast horizon as each period closes. Unlike a static annual budget, a rolling forecast always looks forward the same number of periods (typically 12-18 months).

### Rolling Forecast vs Annual Budget

| Feature          | Annual Budget      | Rolling Forecast       |
| ---------------- | ------------------ | ---------------------- |
| Time Horizon     | Fixed (Jan-Dec)    | Rolling (12-18 months) |
| Update Frequency | Once per year      | Monthly or quarterly   |
| Detail Level     | Very detailed      | Driver-level           |
| Preparation Time | 3-6 months         | 2-5 days per cycle     |
| Relevance        | Declines over time | Stays current          |
| Flexibility      | Rigid              | Adaptive               |

### Implementation Steps

1. **Select the horizon** - 12 months rolling is most common (some use 18 months for CapEx planning)
2. **Define update cadence** - Monthly for volatile businesses; quarterly for stable ones
3. **Choose the right detail** - Driver-level, not line-item detail
4. **Automate data feeds** - Reduce manual effort per cycle
5. **Separate actuals from forecast** - Clear delineation between reported and projected periods
6. **Track forecast accuracy** - Measure MAPE (Mean Absolute Percentage Error) over time

### 13-Week Cash Flow Forecast

A specialized rolling forecast for liquidity management:

**Structure:**

- Week-by-week cash inflows and outflows
- Opening and closing cash balances
- Minimum cash threshold alerts

**Key Components:**
| Inflows | Outflows |
|---------|----------|
| Customer collections (by aging) | Payroll (fixed cadence) |
| Other receivables | Rent / Lease payments |
| Asset sales | Vendor payments (by terms) |
| Financing proceeds | Debt service |
| Tax refunds | Tax payments |
| Other income | Capital expenditures |

**Collection Modeling:**

- Apply collection rates by customer segment or aging bucket
- Model DSO trends to project collection timing
- Account for seasonal patterns in payment behavior

## 3. Accuracy Improvement

### Measuring Forecast Accuracy

**Mean Absolute Percentage Error (MAPE):**

```
MAPE = (1/n) x Sum of |Actual - Forecast| / |Actual| x 100%
```

**Accuracy Benchmarks:**
| MAPE | Rating |
|------|--------|
| < 5% | Excellent |
| 5% - 10% | Good |
| 10% - 20% | Acceptable |
| > 20% | Needs improvement |

**Weighted MAPE (WMAPE):**
Use when line items vary significantly in magnitude - weights errors by actual values.

### Techniques to Improve Accuracy

**1. Bias Detection and Correction**

- Track directional bias (consistently over or under forecasting)
- Calculate mean signed error to detect systematic bias
- Adjust driver assumptions to correct persistent bias

**2. Variance Analysis Loop**

- After each period closes, compare actual vs forecast
- Identify root causes of significant variances
- Update driver assumptions based on learnings
- Document what changed and why

**3. Ensemble Approach**

- Combine multiple forecasting methods
- Blend statistical (trend) with judgmental (management input)
- Weight methods by their historical accuracy

**4. Granularity Optimization**

- Forecast at the right level of detail - not too aggregated, not too granular
- Product/segment level usually more accurate than single top-line
- Aggregate bottom-up forecasts for total, then adjust

**5. Leading Indicators**

- Identify metrics that predict financial outcomes 1-3 months ahead
- Pipeline/bookings predict revenue
- Hiring plans predict headcount costs
- Customer churn signals predict retention revenue

### Common Accuracy Killers

1. **Anchoring bias** - Over-relying on last year's numbers
2. **Optimism bias** - Systematic overestimation of growth
3. **Lack of accountability** - No one tracks forecast vs actual
4. **Stale assumptions** - Not updating for market changes
5. **Missing data** - Forecasting without key driver inputs
6. **Over-precision** - False precision in uncertain environments

## 4. Scenario Planning

### Three-Scenario Framework

| Scenario      | Description                                     | Probability |
| ------------- | ----------------------------------------------- | ----------- |
| **Base Case** | Most likely outcome based on current trajectory | 50-60%      |
| **Bull Case** | Favorable conditions, upside realization        | 15-25%      |
| **Bear Case** | Adverse conditions, downside risks              | 15-25%      |

### Scenario Construction

**Base Case:**

- Continuation of current trends
- Management's operational plan
- Market consensus assumptions
- Normal competitive dynamics

**Bull Case (apply selectively, not uniformly):**

- Faster customer acquisition or market adoption
- Successful product launch or expansion
- Favorable macro conditions
- Competitor weakness or exit
- Margin expansion from operating leverage

**Bear Case (be realistic, not catastrophic):**

- Slower growth or market contraction
- Increased competition or pricing pressure
- Key customer or contract loss
- Supply chain disruption
- Regulatory headwinds

### Scenario Variables

Map each scenario to specific driver values:

| Driver              | Bear | Base | Bull |
| ------------------- | ---- | ---- | ---- |
| Revenue Growth      | +2%  | +8%  | +15% |
| Gross Margin        | 35%  | 40%  | 43%  |
| Customer Churn      | 8%   | 5%   | 3%   |
| New Customers/Month | 50   | 100  | 180  |
| Price Increase      | 0%   | 3%   | 5%   |

### Presenting Scenarios

1. **Show the range** - Management needs to see the potential outcomes
2. **Quantify the gap** - Dollar impact of bull vs bear on key metrics
3. **Identify triggers** - What conditions would cause each scenario
4. **Define actions** - What levers to pull in each scenario
5. **Assign probabilities** - Not all scenarios are equally likely

## 5. Forecast Communication

### Stakeholder Needs

| Audience         | Needs                                                   |
| ---------------- | ------------------------------------------------------- |
| Board            | High-level scenarios, key risks, strategic implications |
| CEO/CFO          | Detailed drivers, variance explanations, action items   |
| Department Heads | Their specific budget vs forecast, headcount plans      |
| Investors        | Revenue guidance, margin trajectory, capital allocation |
| Operations       | Weekly/monthly targets, resource requirements           |

### Presentation Framework

1. **Executive summary** - Key metrics, direction of travel, confidence level
2. **Variance bridge** - Walk from budget/prior forecast to current forecast
3. **Driver analysis** - What changed and why
4. **Scenario comparison** - Range of outcomes
5. **Key risks and opportunities** - What could change the forecast
6. **Action items** - Decisions needed based on forecast

### Forecast Cadence

| Activity                 | Frequency | Time Required |
| ------------------------ | --------- | ------------- |
| 13-week cash flow update | Weekly    | 1-2 hours     |
| Rolling forecast update  | Monthly   | 1-2 days      |
| Full reforecast          | Quarterly | 3-5 days      |
| Annual budget/plan       | Annually  | 4-8 weeks     |
| Board reporting          | Quarterly | 2-3 days      |

## 6. Industry-Specific Considerations

### SaaS Metrics in Forecasting

- **MRR/ARR decomposition:** New, expansion, contraction, churn
- **Cohort-based forecasting:** Forecast by customer cohort for retention accuracy
- **Rule of 40:** Revenue growth % + Profit margin % should exceed 40%
- **Net Revenue Retention:** Target > 110% for healthy SaaS
- **CAC Payback:** Should be < 18 months

### Retail Forecasting

- **Same-store sales growth** as primary organic growth metric
- **Seasonal decomposition** for accurate monthly/weekly forecasts
- **Markdown optimization** impact on gross margin
- **Inventory turns** drive working capital forecasts

### Manufacturing Forecasting

- **Order backlog** as a leading indicator
- **Capacity constraints** creating step-function cost increases
- **Raw material price forecasts** for COGS
- **Maintenance CapEx vs growth CapEx** distinction
- **Utilization rates** driving unit cost projections
