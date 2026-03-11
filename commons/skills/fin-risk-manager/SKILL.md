---
name: fin-risk-manager
status: draft
description: "Risk management suite - position sizing, Value-at-Risk, stress testing, correlation analysis, and risk-adjusted performance metrics for institutional-grade portfolio risk control."
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# Risk Manager

Position sizing, Value-at-Risk, stress testing, correlation analysis, and risk-adjusted performance metrics. Institutional-grade risk control for any portfolio.

## When to Use

**USE this skill when:**

- "how much should I allocate to ETH" / "position size"
- "what's my portfolio VaR" / "value at risk"
- "stress test my portfolio" / "what if BTC drops 50%"
- "correlation between my holdings"
- "Sharpe ratio" / "risk-adjusted returns"
- "am I too concentrated" / "diversification check"
- "Kelly criterion for this trade"
- "max drawdown analysis"

## When NOT to Use

**DON'T use this skill when:**

- User wants to execute a trade -- use fin-trading
- User just wants current prices -- use fin-market-data
- User wants asset research or analysis -- use fin-expert
- User wants to set up DCA plans -- use fin-dca-strategy
- User wants news or sentiment -- use fin-news-intel

## Tools

### Existing Tools

- `fin_portfolio_positions` -- fetch current portfolio holdings
- `fin_portfolio_balances` -- fetch account balances
- `fin_portfolio_history` -- historical portfolio snapshots for drawdown analysis
- `fin_market_price` -- historical OHLCV data for VaR, correlation, and volatility calculations
- `fin_ticker_info` -- 24h metrics, volume, and market cap context

### Risk-Specific Tools (Documented)

- `fin_risk_var` -- compute Value-at-Risk and Conditional VaR
  - Parameters: `portfolio_id`, `confidence_level` (0.95 | 0.99), `method` (historical | parametric), `horizon_days` (1 | 5 | 10)
  - Returns: VaR amount, CVaR (Expected Shortfall), contribution by position

- `fin_risk_stress_test` -- run stress scenarios against portfolio
  - Parameters: `portfolio_id`, `scenario` (crypto_winter | flash_crash | defi_contagion | rate_hike | black_swan | custom), `custom_shocks` (optional asset-level overrides)
  - Returns: portfolio P&L under scenario, per-position impact, margin call risk flag

- `fin_risk_correlation` -- rolling correlation matrix
  - Parameters: `assets[]`, `window` (30 | 60 | 90 days), `method` (pearson)
  - Returns: correlation matrix, highly-correlated pairs (>0.85), effective diversification ratio

- `fin_risk_position_size` -- calculate optimal position size
  - Parameters: `method` (fixed_fractional | kelly | half_kelly | mean_variance), `capital`, `risk_per_trade` (%), `win_rate`, `avg_win`, `avg_loss`, `target_asset`
  - Returns: recommended position size, risk amount, expected value per trade

## Risk Methodology

### 1. Position Sizing

Calculate optimal allocation using one of four methods:

- **Fixed Fractional Risk**: Risk a fixed percentage (1-3%) of total capital per trade. Position size = (Capital x Risk%) / (Entry - StopLoss).
- **Kelly Criterion**: f\* = (bp - q) / b where b = avg_win/avg_loss, p = win_rate, q = 1 - p. Maximizes long-term geometric growth.
- **Half-Kelly** (recommended): f\*/2. Sacrifices ~25% of growth for ~50% less volatility. Default recommendation for most users.
- **Mean-Variance Optimization**: MPT-based allocation targeting the efficient frontier. Requires return estimates and covariance matrix.

Always present all methods side-by-side and recommend Half-Kelly for most individual investors.

### 2. Value-at-Risk (VaR)

Three calculation approaches:

- **Historical VaR**: Sort portfolio returns over lookback window, find the loss at the chosen percentile. Non-parametric, captures fat tails.
- **Parametric VaR**: Assume normal distribution, VaR = mu - z \* sigma. Fast but underestimates tail risk in crypto.
- **Conditional VaR (Expected Shortfall)**: Average of all losses beyond the VaR threshold. Always report CVaR alongside VaR -- it answers "when things go wrong, how bad?"

Default: 95% confidence, 1-day horizon. Always report in both absolute ($) and percentage terms.

### 3. Stress Testing

Five predefined scenarios plus custom:

| Scenario        | BTC  | ETH  | Alts | Stables | Description                               |
| --------------- | ---- | ---- | ---- | ------- | ----------------------------------------- |
| Crypto Winter   | -60% | -70% | -80% | -1%     | Prolonged bear market (2022 analog)       |
| Flash Crash     | -30% | -35% | -50% | 0%      | Sudden liquidation cascade                |
| DeFi Contagion  | -20% | -40% | -60% | -5%     | Smart contract exploit / protocol failure |
| Rate Hike Shock | -15% | -20% | -30% | 0%      | Unexpected Fed tightening                 |
| Black Swan      | -50% | -60% | -90% | -10%    | Exchange collapse / systemic event        |

For custom scenarios, accept per-asset percentage shocks and compute aggregate portfolio impact.

### 4. Risk-Adjusted Performance Metrics

Calculate and present in a summary table:

- **Sharpe Ratio**: (Return - Rf) / StdDev. >1 acceptable, >2 good, >3 excellent.
- **Sortino Ratio**: (Return - Rf) / DownsideStdDev. Penalizes only downside volatility.
- **Calmar Ratio**: CAGR / MaxDrawdown. Measures return per unit of drawdown risk.
- **Max Drawdown**: Largest peak-to-trough decline. Report magnitude, duration, and recovery time.
- **Beta**: Portfolio sensitivity to BTC (crypto) or S&P 500 (traditional). Beta > 1 = amplified market risk.
- **Information Ratio**: (Portfolio Return - Benchmark Return) / Tracking Error. Measures active management skill.

### 5. Correlation Analysis

- Compute rolling Pearson correlation over 30/60/90-day windows.
- Flag highly correlated pairs (r > 0.85) -- these provide minimal diversification benefit.
- Calculate the effective diversification ratio: (sum of individual VaRs) / (portfolio VaR). Higher = better diversified.
- Visualize as a correlation matrix with color coding.

## Response Guidelines

- Always fetch the actual portfolio before running risk analysis -- never assume holdings.
- Present VaR and stress test results in clear tables with both dollar and percentage impact.
- When recommending position sizes, show the calculation step-by-step so users understand the logic.
- Compare multiple sizing methods and explain trade-offs (growth vs. safety).
- Flag concentration risk: warn if any single position exceeds 25% of portfolio.
- Flag correlation risk: warn if effective diversification ratio is below 1.5.
- For stress tests, always show the worst-case scenario's impact on total portfolio value.
- Include actionable recommendations: "To reduce VaR by 20%, consider reducing Position X by Y%."

## Risk Disclosures

- Risk metrics are based on historical data and statistical models. Past performance and historical correlations do not guarantee future results.
- VaR does not capture the magnitude of losses beyond its threshold -- always review CVaR alongside VaR.
- Stress test scenarios are illustrative. Real market events may produce outcomes outside these ranges.
- Position sizing recommendations are mathematical frameworks, not financial advice. Always consider your personal financial situation and risk tolerance.
- Crypto markets exhibit higher volatility and fatter tails than traditional markets. Parametric VaR may significantly underestimate risk.
