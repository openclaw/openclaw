---
name: bankr
description: AI-powered crypto trading agent via natural language. Use when the user wants to trade crypto (buy/sell/swap tokens), check portfolio balances, view token prices, transfer crypto, manage NFTs, use leverage, bet on Polymarket, deploy tokens, set up automated trading strategies, submit raw transactions, execute calldata, or send transaction JSON. Supports Base, Ethereum, Polygon, Solana, and Unichain. Comprehensive capabilities include trading, portfolio management, market research, NFT operations, prediction markets, leverage trading, DeFi operations, automation, and arbitrary transaction submission.
metadata:
  {
    "openclaw":
      {
        "emoji": "📺",
        "homepage": "https://bankr.bot",
        "requires": { "bins": ["curl", "jq"] },
      },
  }
---

# Bankr

Execute crypto trading and DeFi operations using natural language through Bankr's AI agent API.

## Quick Start

### First-Time Setup

There are two ways to get started:

#### Option A: User provides an existing API key

If the user already has a Bankr API key, they can provide it directly:

```bash
mkdir -p ~/.clawdbot/skills/bankr
cat > ~/.clawdbot/skills/bankr/config.json << 'EOF'
{
  "apiKey": "bk_YOUR_KEY_HERE",
  "apiUrl": "https://api.bankr.bot"
}
EOF
```

API keys can be created and managed at [bankr.bot/api](https://bankr.bot/api). The key must have **Agent API** access enabled.

#### Option B: Create a new account (guided by Clawd)

Clawd can walk the user through the full signup flow:

1. **Sign up / Sign in** — User provides their email address. Bankr sends a one-time passcode (OTP) to that email. Creating a new account automatically provisions **EVM wallets** (Base, Ethereum, Polygon, Unichain) and a **Solana wallet** — no manual wallet setup needed.
2. **Enter OTP** — User checks their email and provides the OTP code.
3. **Generate API key** — Once authenticated, navigate to [bankr.bot/api](https://bankr.bot/api) to create an API key with **Agent API** access enabled.
4. **Configure** — Save the key (starts with `bk_`) to config:

```bash
mkdir -p ~/.clawdbot/skills/bankr
cat > ~/.clawdbot/skills/bankr/config.json << 'EOF'
{
  "apiKey": "bk_YOUR_KEY_HERE",
  "apiUrl": "https://api.bankr.bot"
}
EOF
```

#### Verify Setup

```bash
scripts/bankr.sh "What is my balance?"
```

## Core Usage

### Simple Query

For straightforward requests that complete quickly:

```bash
scripts/bankr.sh "What is my ETH balance?"
scripts/bankr.sh "What's the price of Bitcoin?"
```

The main script handles the full submit-poll-complete workflow automatically.

### Manual Job Control

For advanced use or long-running operations:

```bash
# Submit and get job ID
JOB_ID=$(scripts/bankr-submit.sh "Buy $100 of ETH" | jq -r '.jobId')

# Poll for status
scripts/bankr-status.sh "$JOB_ID"

# Cancel if needed
scripts/bankr-cancel.sh "$JOB_ID"
```

## Capabilities Overview

### Trading Operations

- **Token Swaps**: Buy/sell/swap tokens across chains
- **Cross-Chain**: Bridge tokens between chains
- **Limit Orders**: Execute at target prices
- **Stop Loss**: Automatic sell protection
- **DCA**: Dollar-cost averaging strategies
- **TWAP**: Time-weighted average pricing

**Reference**: [references/token-trading.md](references/token-trading.md)

### Portfolio Management

- Check balances across all chains
- View USD valuations
- Track holdings by token or chain
- Real-time price updates
- Multi-chain aggregation

**Reference**: [references/portfolio.md](references/portfolio.md)

### Market Research

- Token prices and market data
- Technical analysis (RSI, MACD, etc.)
- Social sentiment analysis
- Price charts
- Trending tokens
- Token comparisons

**Reference**: [references/market-research.md](references/market-research.md)

### Transfers

- Send to addresses, ENS, or social handles
- Multi-chain support
- Flexible amount formats
- Social handle resolution (Twitter, Farcaster, Telegram)

**Reference**: [references/transfers.md](references/transfers.md)

### NFT Operations

- Browse and search collections
- View floor prices and listings
- Purchase NFTs via OpenSea
- View your NFT portfolio
- Transfer NFTs
- Mint from supported platforms

**Reference**: [references/nft-operations.md](references/nft-operations.md)

### Polymarket Betting

- Search prediction markets
- Check odds
- Place bets on outcomes
- View positions
- Redeem winnings

**Reference**: [references/polymarket.md](references/polymarket.md)

### Leverage Trading

- Long/short positions (up to 50x crypto, 100x forex/commodities)
- Crypto, forex, and commodities
- Stop loss and take profit
- Position management via Avantis on Base

**Reference**: [references/leverage-trading.md](references/leverage-trading.md)

### Token Deployment

- **EVM (Base)**: Deploy ERC20 tokens via Clanker with customizable metadata and social links
- **Solana**: Launch SPL tokens via Raydium LaunchLab with bonding curve and auto-migration to CPMM
- Creator fee claiming on both chains
- Fee Key NFTs for Solana (50% LP trading fees post-migration)
- Optional fee recipient designation with 99.9%/0.1% split (Solana)
- Both creator AND fee recipient can claim bonding curve fees (gas sponsored)
- Optional vesting parameters (Solana)
- Rate limits: 1/day standard, 10/day Bankr Club (gas sponsored within limits)

**Reference**: [references/token-deployment.md](references/token-deployment.md)

### Automation

- Limit orders
- Stop loss orders
- DCA (dollar-cost averaging)
- TWAP (time-weighted average price)
- Scheduled commands

**Reference**: [references/automation.md](references/automation.md)

### Arbitrary Transactions

- Submit raw EVM transactions with explicit calldata
- Custom contract calls to any address
- Execute pre-built calldata from other tools
- Value transfers with data

**Reference**: [references/arbitrary-transaction.md](references/arbitrary-transaction.md)

## Supported Chains

| Chain    | Native Token | Best For                      | Gas Cost |
| -------- | ------------ | ----------------------------- | -------- |
| Base     | ETH          | Memecoins, general trading    | Very Low |
| Polygon  | MATIC        | Gaming, NFTs, frequent trades | Very Low |
| Ethereum | ETH          | Blue chips, high liquidity    | High     |
| Solana   | SOL          | High-speed trading            | Minimal  |
| Unichain | ETH          | Newer L2 option               | Very Low |

## Common Patterns

### Check Before Trading

```bash
# Check balance
scripts/bankr.sh "What is my ETH balance on Base?"

# Check price
scripts/bankr.sh "What's the current price of PEPE?"

# Then trade
scripts/bankr.sh "Buy $20 of PEPE on Base"
```

### Portfolio Review

```bash
# Full portfolio
scripts/bankr.sh "Show my complete portfolio"

# Chain-specific
scripts/bankr.sh "What tokens do I have on Base?"

# Token-specific
scripts/bankr.sh "Show my ETH across all chains"
```

### Set Up Automation

```bash
# DCA strategy
scripts/bankr.sh "DCA $100 into ETH every week"

# Stop loss protection
scripts/bankr.sh "Set stop loss for my ETH at $2,500"

# Limit order
scripts/bankr.sh "Buy ETH if price drops to $3,000"
```

### Market Research

```bash
# Price and analysis
scripts/bankr.sh "Do technical analysis on ETH"

# Trending tokens
scripts/bankr.sh "What tokens are trending on Base?"

# Compare tokens
scripts/bankr.sh "Compare ETH vs SOL"
```

## API Workflow

Bankr uses an asynchronous job-based API:

1. **Submit** - Send prompt, get job ID
2. **Poll** - Check status every 2 seconds
3. **Complete** - Process results when done

The `bankr.sh` wrapper handles this automatically. For details on the API structure, job states, polling strategy, and error handling, see:

**Reference**: [references/api-workflow.md](references/api-workflow.md)

### Synchronous Endpoints

For direct signing and transaction submission, Bankr also provides synchronous endpoints:

- **POST /agent/sign** - Sign messages, typed data, or transactions without broadcasting
- **POST /agent/submit** - Submit raw transactions directly to the blockchain

These endpoints return immediately (no polling required) and are ideal for:
- Authentication flows (sign messages)
- Gasless approvals (sign EIP-712 permits)
- Pre-built transactions (submit raw calldata)

**Reference**: [references/sign-submit-api.md](references/sign-submit-api.md)

## Error Handling

Common issues and fixes:

- **Authentication errors** → Check API key setup
- **Insufficient balance** → Add funds or reduce amount
- **Token not found** → Verify symbol and chain
- **Transaction reverted** → Check parameters and balances
- **Rate limiting** → Wait and retry

For comprehensive error troubleshooting, setup instructions, and debugging steps, see:

**Reference**: [references/error-handling.md](references/error-handling.md)

## Best Practices

### Security

1. Never share your API key
2. Start with small test amounts
3. Verify addresses before large transfers
4. Use stop losses for leverage trading
5. Double-check transaction details

### Trading

1. Check balance before trades
2. Specify chain for lesser-known tokens
3. Consider gas costs (use Base/Polygon for small amounts)
4. Start small, scale up after testing
5. Use limit orders for better prices

### Automation

1. Test automation with small amounts first
2. Review active orders regularly
3. Set realistic price targets
4. Always use stop loss for leverage
5. Monitor execution and adjust as needed

## Tips for Success

### For New Users

- Start with balance checks and price queries
- Test with $5-10 trades first
- Use Base for lower fees
- Enable trading confirmations initially
- Learn one feature at a time

### For Experienced Users

- Leverage automation for strategies
- Use multiple chains for diversification
- Combine DCA with stop losses
- Explore advanced features (leverage, Polymarket)
- Monitor gas costs across chains

## Prompt Examples by Category

### Trading

- "Buy $50 of ETH on Base"
- "Swap 0.1 ETH for USDC"
- "Sell 50% of my PEPE"
- "Bridge 100 USDC from Polygon to Base"

### Portfolio

- "Show my portfolio"
- "What's my ETH balance?"
- "Total portfolio value"
- "Holdings on Base"

### Market Research

- "What's the price of Bitcoin?"
- "Analyze ETH price"
- "Trending tokens on Base"
- "Compare UNI vs SUSHI"

### Transfers

- "Send 0.1 ETH to vitalik.eth"
- "Transfer $20 USDC to @friend"
- "Send 50 USDC to 0x123..."

### NFTs

- "Show Bored Ape floor price"
- "Buy cheapest Pudgy Penguin"
- "Show my NFTs"

### Polymarket

- "What are the odds Trump wins?"
- "Bet $10 on Yes for [market]"
- "Show my Polymarket positions"

### Leverage

- "Open 5x long on ETH with $100"
- "Short BTC 10x with stop loss at $45k"
- "Show my Avantis positions"

### Automation

- "DCA $100 into ETH weekly"
- "Set limit order to buy ETH at $3,000"
- "Stop loss for all holdings at -20%"

### Token Deployment

**Solana (LaunchLab):**

- "Launch a token called MOON on Solana"
- "Launch a token called FROG and give fees to @0xDeployer"
- "Deploy SpaceRocket with symbol ROCK"
- "Launch BRAIN and route fees to 7xKXtg..."
- "How much fees can I claim for MOON?"
- "Claim my fees for MOON" (works for creator or fee recipient)
- "Show my Fee Key NFTs"
- "Claim my fee NFT for ROCKET" (post-migration)
- "Transfer fees for MOON to 7xKXtg..."

**EVM (Clanker):**

- "Deploy a token called BankrFan with symbol BFAN on Base"
- "Claim fees for my token MTK"

### Arbitrary Transactions

- "Submit this transaction: {to: 0x..., data: 0x..., value: 0, chainId: 8453}"
- "Execute this calldata on Base: {...}"
- "Send raw transaction with this JSON: {...}"

### Sign API (Synchronous)

Direct message signing without AI processing:

```bash
# Sign a plain text message
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signatureType": "personal_sign", "message": "Hello, Bankr!"}'

# Sign EIP-712 typed data (permits, orders)
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signatureType": "eth_signTypedData_v4", "typedData": {...}}'

# Sign a transaction without broadcasting
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signatureType": "eth_signTransaction", "transaction": {"to": "0x...", "chainId": 8453}}'
```

### Submit API (Synchronous)

Direct transaction submission without AI processing:

```bash
# Submit a raw transaction
curl -X POST "https://api.bankr.bot/agent/submit" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": {"to": "0x...", "chainId": 8453, "value": "1000000000000000000"},
    "waitForConfirmation": true
  }'
```

**Reference**: [references/sign-submit-api.md](references/sign-submit-api.md)

## Resources

- **Agent API Reference**: https://www.notion.so/Agent-API-2e18e0f9661f80cb83ccfc046f8872e3
- **API Key Management**: https://bankr.bot/api
- **Terminal**: https://bankr.bot/terminal
- **Twitter**: @bankr_bot

## Troubleshooting

### Scripts Not Working

```bash
# Ensure scripts are executable
chmod +x ~/.clawdbot/skills/bankr/scripts/*.sh

# Test connectivity
curl -I https://api.bankr.bot
```

### API Errors

See [references/error-handling.md](references/error-handling.md) for comprehensive troubleshooting.

### Getting Help

1. Check error message in response JSON
2. Consult relevant reference document
3. Verify configuration and connectivity
4. Test with simple queries first

---

**💡 Pro Tip**: The most common issue is not specifying the chain for tokens. When in doubt, always include "on Base" or "on Ethereum" in your prompt.

**⚠️ Security**: Keep your API key private. Never commit config.json to version control. Only trade amounts you can afford to lose.

**🚀 Quick Win**: Start by checking your portfolio to see what's possible, then try a small $5-10 trade on Base to get familiar with the flow.
