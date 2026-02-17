# BlockRun (OpenClaw plugin)

Provider plugin for **BlockRun** — smart LLM routing with x402 micropayments.

## Features

| Feature           | Benefit                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| **Smart Routing** | Auto-selects the best model for each request                           |
| **30+ Models**    | OpenAI, Anthropic, Google, DeepSeek, xAI — all through one integration |
| **No API Keys**   | Pay-per-request with USDC micropayments (x402 protocol)                |
| **Free Tier**     | NVIDIA GPT-OSS-120B at $0 for simple queries                           |

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable blockrun
```

Restart the Gateway after enabling.

## Install ClawRouter

```bash
npm install -g @blockrun/clawrouter
```

## Start the Proxy

```bash
clawrouter start
```

This starts the local proxy on port 8402. A wallet is auto-generated on first run.

## Authenticate

```bash
openclaw models auth login --provider blockrun --set-default
```

## Usage

```bash
# Smart routing (recommended)
openclaw config set model blockrun/auto

# Free tier
openclaw config set model blockrun/free

# Direct model access
openclaw config set model blockrun/openai/gpt-4o
openclaw config set model blockrun/anthropic/claude-sonnet-4
```

## Fund Your Wallet

ClawRouter creates a wallet automatically. To add funds:

1. Run `clawrouter wallet` to see your wallet address
2. Send USDC (Base network) to the address
3. Or visit https://blockrun.ai/fund for easy funding

## Links

- npm: [@blockrun/clawrouter](https://www.npmjs.com/package/@blockrun/clawrouter)
- GitHub: [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter)
- x402: [x402.org](https://x402.org)
