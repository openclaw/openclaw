---
name: fin-setting
description: "Configure exchanges, risk parameters, notifications, and trading preferences. Use when: user wants to add exchanges, set risk limits, or configure notifications."
metadata: { "openclaw": { "emoji": "⚙️", "requires": { "extensions": ["findoo-trader-plugin"] } } }
---

# Setting Skill

Configure exchange connections, risk parameters, notifications, and trading preferences.

## When to Use

**USE this skill when:**

- "添加交易所" / "add exchange" / "connect binance"
- "设置止损" / "set max drawdown"
- "配置通知" / "configure notifications"
- "交易所列表" / "list exchanges"
- "测试连接" / "test exchange connection"
- "修改风控参数" / "update risk settings"
- "删除交易所" / "remove exchange"

## When NOT to Use

**DON'T use this skill when:**

- User wants to place a trade -- use fin-trader
- User wants strategy management -- use fin-strategy
- User asks about portfolio or balances -- use fin-portfolio
- User asks for market data -- use fin-market-data

## Dashboard & API Endpoints

### Exchange Management

- Setting page: `/dashboard/setting`
- List exchanges: `GET /api/v1/finance/exchanges`
- Add exchange: `POST /api/v1/finance/exchanges` (body: `{ name, exchange, apiKey, secret, testnet }`)
- Test connection: `POST /api/v1/finance/exchanges/test` (body: `{ name }`)
- Remove exchange: `POST /api/v1/finance/exchanges/remove` (body: `{ name }`)

### Configuration

- Trading config: `GET/POST /api/v1/finance/config/trading`
- Agent config: `GET/POST /api/v1/finance/config/agent`
- Risk gates: `GET/POST /api/v1/finance/config/gates`
- Config SSE: `/api/v1/finance/config/stream`

### CLI Commands

```bash
openfinclaw exchange list          # List configured exchanges
openfinclaw exchange add <name>    # Add an exchange
openfinclaw exchange remove <name> # Remove an exchange
```

## Supported Exchanges

| Exchange    | Type          | Testnet | Passphrase |
| ----------- | ------------- | ------- | ---------- |
| Binance     | `binance`     | Yes     | No         |
| OKX         | `okx`         | Yes     | Yes        |
| Bybit       | `bybit`       | Yes     | No         |
| Hyperliquid | `hyperliquid` | Yes     | No         |

## Risk Parameters

Key risk settings configurable via the dashboard:

- **Max position size** — maximum single position as % of portfolio
- **Max daily loss** — stop trading if daily loss exceeds threshold
- **Max drawdown** — halt all strategies if drawdown exceeds limit
- **Order size limit** — maximum single order value in USD
- **Emergency stop** — instantly halt all trading activity

## Response Guidelines

- When adding an exchange, remind users to use API keys with trade-only permissions (no withdrawal).
- Recommend testnet mode first for new exchange connections.
- After adding an exchange, suggest running a connection test.
- Never display full API keys or secrets — show only masked versions.
- For risk parameter changes, explain the impact clearly before applying.
