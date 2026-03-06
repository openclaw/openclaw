# @openfinclaw/openfinclaw

Complete financial tools suite for OpenClaw.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

Or manually:

```bash
openclaw plugins install @openfinclaw/openfinclaw
```

## Features

- **fin-strategy-builder** - Turn natural language trading ideas into FEP v1.2 strategy packages
- **fin-backtest-remote** - Submit and manage backtests on remote server
- **fin-market-data** - Market data tools (prices, orderbooks, tickers)
- **fin-strategy-engine** - Strategy lifecycle management

## Configuration

After installation, configure your API key:

```bash
# Get your API key at https://hub.openfinclaw.ai
openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_API_KEY
openclaw config set plugins.entries.openfinclaw.config.backtestApiUrl https://backtest.openfinclaw.ai
```

## Skills

### fin-strategy-builder

Create trading strategies from natural language:

```
User: "帮我创建一个 BTC 定投策略，每周买入 100 美元"
```

The skill will generate:

- `fep.yaml` - Strategy configuration
- `scripts/strategy.py` - Strategy entry point

## Links

- **Repository**: https://github.com/cryptoSUN2049/openFinclaw
- **Get API Key**: https://hub.openfinclaw.ai

## License

MIT
