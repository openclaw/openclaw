# Token Trading Reference

Execute token trades and swaps across multiple blockchains.

## Supported Chains

| Chain | Native Token | Characteristics |
|-------|--------------|-----------------|
| Base | ETH | Low fees, ideal for memecoins |
| Polygon | MATIC | Fast, cheap transactions |
| Ethereum | ETH | Highest liquidity, expensive gas |
| Unichain | ETH | Newer L2 option |
| Solana | SOL | High speed, minimal fees |

## Amount Formats

| Format | Example | Description |
|--------|---------|-------------|
| USD | `$50` | Dollar amount to spend |
| Percentage | `50%` | Percentage of your balance |
| Exact | `0.1 ETH` | Specific token amount |

## Prompt Examples

**Same-chain swaps:**
- "Swap 0.1 ETH for USDC on Base"
- "Buy $50 of BNKR on Base"
- "Sell 50% of my ETH holdings"
- "Purchase 100 USDC worth of PEPE"

**Cross-chain swaps:**
- "Bridge 0.5 ETH from Ethereum to Base"
- "Move 100 USDC from Polygon to Solana"

**ETH/WETH conversion:**
- "Convert 0.1 ETH to WETH"
- "Unwrap 0.5 WETH to ETH"

## Chain Selection

- If no chain specified, Bankr selects the most appropriate chain
- Base is preferred for most operations due to low fees
- Cross-chain routes are automatically optimized
- Include chain name in prompt to specify: "Buy ETH on Polygon"

## Slippage

- Default slippage tolerance is applied automatically
- For volatile tokens, Bankr adjusts slippage as needed
- If slippage is exceeded, the transaction fails safely
- You can specify: "with 1% slippage"

## Common Issues

| Issue | Resolution |
|-------|------------|
| Insufficient balance | Reduce amount or add funds |
| Token not found | Check token symbol/address, specify chain |
| High slippage | Try smaller amounts or use limit orders |
| Network congestion | Wait and retry, or try L2 |
| Gas too high | Use Base/Polygon, or wait for lower gas |

## Best Practices

1. **Start small** - Test with small amounts first
2. **Specify chains** - For lesser-known tokens, always include chain
3. **Check slippage** - Be careful with low-liquidity tokens
4. **Monitor gas** - Ethereum mainnet can be expensive
5. **Use L2s** - Base and Polygon offer much lower fees
