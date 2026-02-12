# SKILL: SOLANA SIMULATE

Verification and dry-run protocol for Solana transactions and program instructions.

## SIMULATION PROTOCOL

When preparing or auditing Solana code, you MUST simulate the execution path:

1. **CU Budgeting**: Estimate Compute Units. If logic exceeds 200k CU, flag for optimization or heap frame increase.
2. **State Transition**: Predict the exact account data changes.
3. **Signer Requirements**: Identify every account that MUST be a signer.
4. **Error Paths**: Explicitly simulate what happens if any `checked_*` math operation fails.

## TOOLS & COMMANDS

Use these tools to verify logic:

- **LiteSVM**: Fastest unit simulation. Use for pure logic checks.
- **Surfpool**: Use for testing interactions with existing mainnet accounts (forked).
- **`solana-verify`**: Check build deterministic properties.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> Before suggesting a transaction to the user, use `<think>` to simulate:
>
> 1. Is the `recent_blockhash` handling valid for the intended expiry?
> 2. Will the transaction fail if price impact > X% (for swaps)?
> 3. Are Wright/Partial Signers correctly handled?
