# FlashClaw Examples

This directory contains example scripts demonstrating how to use FlashClaw.

## Examples

### Arbitrage Bot Example

**File:** `arbitrage-bot-example.mjs`

Demonstrates how to programmatically use the FlashClaw arbitrage bot API:

```bash
# Run the example
node examples/arbitrage-bot-example.mjs
```

This example shows:
- How to configure the arbitrage bot
- Starting and stopping the bot
- Monitoring statistics
- Handling graceful shutdown

## Environment Setup

Before running examples, ensure you have:

1. Configured your environment variables:
```bash
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
export PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
```

2. Or use a `.env` file:
```bash
cp ../.env.arbitrage.example ../.env.arbitrage
# Edit .env.arbitrage with your values
```

## Safety Notes

⚠️ These examples use real blockchain networks. Always:
- Test on testnets first (Goerli, Sepolia)
- Start with small amounts
- Monitor gas prices
- Keep private keys secure
- Never commit credentials to git

## More Examples Coming Soon

- Multi-chain arbitrage
- Custom DEX integration
- MEV protection with Flashbots
- Telegram/Discord notifications
- Advanced monitoring dashboards
