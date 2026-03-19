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

3. Install recommended skills (include strategy builder and remote backtest support):

   ```bash
   openclaw commons install strategy-builder
   openclaw commons install fin-dca-strategy
   openclaw commons install fin-tax-report
   ```

4. (Optional) Configure remote backtest: edit `openclaw.json` and set `plugins.entries.fin-backtest-remote.config.apiKey` if your Findoo Backtest server requires it. Leave empty for local/dev without auth.

5. Configure your exchange connections in `openclaw.json`.

## Included Configuration

- **openclaw.json** - Base configuration with:
  - **tools.profile: "coding"** so that Strategy Builder (strategy-builder) and coding-agent have **read**, **exec**, **write**, **edit** for generating strategies and running commands.
  - **plugins.entries.fin-backtest-remote** enabled with a default **baseUrl**; set **apiKey** if your Findoo Backtest server requires authentication.
- **skills.json** - List of recommended financial skills (includes **strategy-builder** for conversation-time strategy creation and remote backtest flow).

## Strategy & Remote Backtest (conversation)

To use **strategy building** and **remote Findoo backtest** in chat:

1. **Tools**: Already set by template — `tools.profile: "coding"`.
2. **Strategy builder skill**: Run `openclaw commons install strategy-builder` so the agent can create FEP v2.0 strategy packages in the current session.
3. **Remote backtest plugin**: Template enables `fin-backtest-remote` with a default baseUrl. Set `plugins.entries.fin-backtest-remote.config.apiKey` in `openclaw.json` if your server requires it; restart Gateway after config changes.

See [Conversation strategy & backtest config](https://docs.openclaw.ai/finance/conversation-strategy-backtest-config) for full details.

## Recommended Skills

| Skill            | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| strategy-builder | FEP v2.0 strategy packages, validate, submit to remote backtest |
| fin-market-data  | Real-time prices, charts, and market data                       |
| fin-portfolio    | Portfolio tracking and P&L analysis                             |
| fin-trading      | Order execution with safety confirmations                       |
| fin-dca-strategy | Dollar-cost averaging plan builder                              |
| fin-tax-report   | Tax reporting and capital gains calculation                     |
| fin-alerts       | Price and portfolio alert monitoring                            |
| fin-expert       | Deep financial analysis and research                            |

## Learn More

Visit the [OpenClaw documentation](https://docs.openclaw.ai) for guides on configuring exchanges, setting up alerts, and customizing skills.
