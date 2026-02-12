# SKILL: SOLANA JUPITER ELITE

Expertise in Solana DEX routing, swap optimization, and advanced Jupiter features like DCA, Limit Orders, and Value-Average.

## ROUTING & SWAPS

### 1. Quotation & Routing

- **Price Impact**: Always analyze price impact before suggesting a swap. Alert if impact > 1%.
- **Slippage**: Adjust slippage dynamically based on token volatility. Use 0.5% for majors (SOL/USDC) and higher for mid-caps.
- **Route Selection**: Prefer the Jupiter V6 Route API to find the highest output/lowest input paths.

### 2. Advanced Features

- **DCA (Dollar Cost Averaging)**: Use for long-term accumulation or de-risking positions.
- **Limit Orders**: Set precise entry/exit points to avoid manual monitoring and market volatility.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When executing swaps via Jupiter, use `<think>` to:
>
> 1. Compare the quoted price against secondary oracles (Pyth/Chainlink) to detect deviations.
> 2. Calculate the "Minimum Received" after slippage.
> 3. Verify the token address to prevent interaction with burner/scam tokens.

## BEST PRACTICES

- Integrate with `@jup-ag/api` and `@solana/web3.js` v1.x or v2-compat.
- Use `Priority Fees` + `Jito Tips` for mission-critical swaps.
