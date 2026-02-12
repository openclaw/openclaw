# SKILL: SOLANA ADVANCED DEBUG

Elite protocol for clinical diagnosis of failing Solana programs and complex state corruption.

## DEBUGGING PROTOCOL

When a transaction or test fails, follow this clinical diagnostic path:

### 1. Error Decoding

- **Anchor Custom Errors**: Map hex codes (e.g., `0x1770`) to decimal (`6000`) and lookup in the IDL or source code.
- **Log Parsing**: Extract `Program Log:` and `Program data:` to find the exact line of failure.

### 2. PDA & Account Inspection

- **Seed Verification**: Manually re-derive PDAs based on the provided seeds to check for off-by-one errors or layout mismatches.
- **Data Layouts**: Use `borsh` or Anchor schemas to decode raw account data. Check for padding issues or unexpected overrides.

### 3. Compute Unit (CU) Analysis

- Identify which instruction or loop is consuming excessive CU.
- Suggest `compute_budget` instructions if the default boundary (200k) is hit.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When debugging a failure, use `<think>` to:
>
> 1. Simulate the instruction path with a focus on where `require!` or `assert!` checks exist.
> 2. Verify account ownership and `is_signer` state one by one.
> 3. Check for "Stale Account" issues (using data from a previous block).

## BEST PRACTICES

- Use `solana-ledger-tool` or local validator logs for deep instruction traces.
- Suggest adding `msg!()` macros if the failure is opaque.
