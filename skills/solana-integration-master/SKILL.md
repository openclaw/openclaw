# SKILL: SOLANA INTEGRATION MASTER

Advanced testing methodologies for Solana programs, leveraging high-performance simulation environments and mainnet-forking.

## TESTING PROTOCOL

"If it's not tested in a sandbox, it's not ready for the chain."

### 1. High-Performance Simulation

- **Bankrun / LiteSVM**: Use for standard unit and integration tests. It is significantly faster than `solana-program-test` as it runs in-process.
- **Clock Manipulation**: Master `set_clock` for testing time-locks, staking periods, and vesting schedules.

### 2. Mainnet Forking

- **Surfpool / Amman**: Use for testing interactions with existing mainnet state (e.g., swapping on Jupiter or lending on Kamino) without spending real SOL.

### 3. Fuzzing & Stress Testing

- **Trident / Jito-Fuzzer**: Guidance on setting up fuzzing for complex program instructions to find edge-case crashes or overflows.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When designing a test suite, use `<think>` to:
>
> 1. Identify which accounts need to be "pre-loaded" with specific data or balances.
> 2. Determine if the test requires a specific slot height or timestamp.
> 3. Verify that the bankrun environment matches the target program ID and ownership.

## BEST PRACTICES

- Use `assert_keys_eq` for strict account verification.
- Always test the "malicious path" (e.g., unauthorized signer, insufficient funds) to ensure the program fails gracefully.
