# SKILL: SOLANA JITO ELITE

Mastery of Jito-specific transaction features, tip management, and bundle construction for MEV resistance and execution guarantees.

## JITO PROTOCOLS

### 1. Tip Management

- **Tip Accounts**: Always use the official Jito tip accounts (e.g., `96g9sAg9thB67o7uBD75CYuC7DeB1XAzRfB3oohNY7Gi`).
- **Tip Amount**: Calculate tips based on network congestion and block profitability.
- **Placement**: Add the tip as the LAST instruction in the transaction or bundle.

### 2. Bundle Construction

- **Atomic Execution**: Use bundles to ensure multiple transactions succeed or fail together.
- **MEV Protection**: Jito-Solana validator set protects against front-running and sandwiching within the bundle.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When optimizing for Jito, use `<think>` to:
>
> 1. Verify if the transaction is time-sensitive (e.g., liquidations).
> 2. Determine the optimal Jito tip vs. default priority fee ratio.
> 3. Check if a bundle is necessary for multiple related set-ups.

## TIPS & BEST PRACTICES

- Use `Adyen` or `Helius` RPCs with native Jito support where possible.
- Avoid using Jito for low-value, non-critical transfers to save on tips.
