# Portfolio Reference

Query token balances and portfolio across all supported chains.

## Supported Chains

All chains: Base, Polygon, Ethereum, Unichain, Solana

## Prompt Examples

**Full portfolio:**
- "Show my portfolio"
- "What's my total balance?"
- "How much crypto do I have?"
- "Portfolio value"
- "What's my net worth?"

**Chain-specific:**
- "Show my Base balance"
- "What tokens do I have on Polygon?"
- "Ethereum portfolio"
- "Solana holdings"

**Token-specific:**
- "How much ETH do I have?"
- "What's my USDC balance?"
- "Show my ETH across all chains"
- "BNKR balance"

## Features

- **USD Valuation**: All balances include current USD value
- **Multi-Chain Aggregation**: See the same token across all chains
- **Real-Time Prices**: Values reflect current market prices
- **Comprehensive View**: Shows all tokens with meaningful balances

## Common Tokens Tracked

- **Stablecoins**: USDC, USDT, DAI
- **Blue Chips**: ETH, WETH, WBTC
- **DeFi**: UNI, AAVE, LINK, COMP, CRV
- **Memecoins**: DOGE, SHIB, PEPE, BONK
- **Project tokens**: BNKR, ARB, OP, MATIC

## Use Cases

**Before trading:**
- "Do I have enough ETH to swap for 100 USDC?"
- "Check if I have MATIC for gas on Polygon"

**Portfolio review:**
- "What's my largest holding?"
- "Show portfolio breakdown by chain"
- "What percentage of my portfolio is stablecoins?"

**After transactions:**
- "Did my ETH arrive?"
- "Show my new BNKR balance"
- "Verify the swap completed"

## Output Format

Portfolio responses typically include:
- Token name and symbol
- Amount held
- Current USD value
- Chain location
- Price per token
- 24h price change

## Notes

- Balance queries are read-only (no transactions)
- Shows balance of connected wallet address
- Very small balances (dust) may be excluded
- Includes native tokens (ETH, MATIC, SOL) and ERC20/SPL tokens
