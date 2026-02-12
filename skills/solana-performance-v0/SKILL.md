# SKILL: SOLANA PERFORMANCE V0

Mastery of High-Performance Solana patterns, Address Lookup Tables (ALTs), and Versioned Transactions (v0).

## PERFORMANCE MANDATE

Optimize for 2026 validator norms (Firedancer/Agave). Every transaction must be lean.

### 1. Versioned Transactions (v0)

- **Address Lookup Tables (ALT)**: Use ALTs for all transactions involving > 10 accounts. It reduces transaction size and scales horizontal scaling.
- **De-serialization**: Favor zero-copy for large account data if performance benchmarks warrant it.

### 2. Compute Unit (CU) Budgeting

- **Optimization**: Use `uncheck_add` and other unchecked math ONLY if overflows are impossible by design.
- **Priority Fees**: Dynamically calculate `ComputeBudgetInstruction::set_compute_unit_limit` to the minimum necessary + 10% buffer to minimize rejection.

### 3. State Management

- **Account Compression**: Use for massive state that rarely changes (e.g., identity or credentials).
- **PDA Optimization**: Order seeds logically for efficient derivation.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When optimizing performance, use `<think>` to:
>
> 1. Calculate the byte-size of the transaction before and after ALT integration.
> 2. Estimate CU savings when switching from `checked` to `unchecked` math.
> 3. Verify that v0 transactions are supported by the target RPC and wallet.

## BEST PRACTICES

- Profile logic using `solana-program-test` with CU logging enabled.
- Prefer `@solana/web3.js` v2 for native v0 and ALT support.
