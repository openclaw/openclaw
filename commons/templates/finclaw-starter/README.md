# FinClaw Starter Workspace

A starter workspace for financial intelligence with OpenClaw. This template includes recommended skills and sensible defaults for financial workflows.

## Getting Started

1. Install the workspace template:

   ```bash
   openclaw commons install finclaw-starter --dir ./my-finance-workspace
   ```

2. Navigate to the workspace:

   ```bash
   cd my-finance-workspace
   ```

3. Install recommended skills:

   ```bash
   openclaw commons install fin-quant-fund
   openclaw commons install fin-strategy-research
   ```

4. Configure your exchange connections in `openclaw.json`.

## Required Extensions

| Extension              | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| findoo-trader-plugin   | Trading, paper trading, strategy engine, fund mgmt |
| findoo-datahub-plugin  | Market data, indicators, regime detection          |
| findoo-backtest-plugin | Remote backtesting                                 |
| fin-evolution-engine   | GEP gene evolution, RDAVD fitness                  |

## Recommended Skills

| Skill                  | Description                                       |
| ---------------------- | ------------------------------------------------- |
| fin-quant-fund         | One-person quant fund management                  |
| fin-strategy-research  | Strategy research and Walk-Forward validation     |
| fin-strategy-evolution | Strategy lifecycle — promotion, mutation, culling |
| fin-trade-review       | Trade review and learning                         |
| fin-backtest           | Strategy backtesting with Monte Carlo             |
| fin-risk-manager       | Position sizing, VaR, stress testing              |
| fin-news-intel         | AI-powered news analysis and sentiment            |
| fin-macro-calendar     | Economic calendar and regime classification       |
| fin-onchain            | On-chain analytics, DeFi yields                   |
| fin-dca-strategy       | Dollar-cost averaging plan builder                |
| fin-tax-report         | Tax reporting and capital gains                   |

## Learn More

Visit the [OpenClaw documentation](https://docs.openclaw.ai) for guides on configuring exchanges, setting up alerts, and customizing skills.
