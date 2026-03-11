# @openfinclaw/openfinclaw

Financial tools for OpenClaw: strategy builder, publishing, and backtest.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
```

Or manually:

```bash
openclaw plugins install @openfinclaw/openfinclaw
```

## Features

- **skill-publish** - Publish strategies to server with automatic backtest
- **fin-strategy-builder** - Turn natural language trading ideas into FEP v1.2 strategy packages

### Available Tools

| Tool                   | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `skill_publish`        | Publish a strategy ZIP to server (auto-trigger backtest) |
| `skill_publish_verify` | Query publish status and get backtest report             |
| `skill_validate`       | Validate strategy package directory locally              |

## Configuration

After installation, configure your API key:

```bash
# Get your API key at https://hub.openfinclaw.ai
openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_API_KEY

# Optional: modify server URL (default: https://hub.openfinclaw.ai)
openclaw config set plugins.entries.openfinclaw.config.skillApiUrl https://hub.openfinclaw.ai
```

Or use environment variables:

```bash
export SKILL_API_KEY=YOUR_API_KEY
export SKILL_API_URL=https://hub.openfinclaw.ai
```

### Configuration Options

| Config Key         | Environment Variable       | Description                      | Default                      |
| ------------------ | -------------------------- | -------------------------------- | ---------------------------- |
| `skillApiKey`      | `SKILL_API_KEY`            | API key (fch\_ prefix, 68 chars) | Required                     |
| `skillApiUrl`      | `SKILL_API_URL`            | Skill server URL                 | `https://hub.openfinclaw.ai` |
| `requestTimeoutMs` | `SKILL_REQUEST_TIMEOUT_MS` | Request timeout in milliseconds  | `60000`                      |

## Skills

### skill-publish

Publish strategies and get backtest results:

```
User: "发布我的策略到服务器"
Agent:
1. skill_validate(dirPath) → validate locally
2. [zip the directory]
3. skill_publish(filePath) → get submissionId, backtestTaskId
4. skill_publish_verify(submissionId) → poll until completed
5. Return backtest report
```

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
