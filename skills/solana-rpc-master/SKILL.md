# SKILL: SOLANA RPC MASTER

Advanced integration with Solana RPC infrastructure, observability platforms, and real-time event streaming.

## INFRASTRUCTURE PROTOCOL

Master the plumbing. An elite agent sees the state before it solidifies.

### 1. Advanced APIs

- **Helius DAS (Digital Asset System)**: Use for high-speed indexing of NFTs and Compressed NFTs. It's faster than querying the ledger directly.
- **Priority Fee API**: Integrate with RPC-specific priority fee estimators (Helius/Triton) for reliable execution.

### 2. Real-Time Streaming

- **YellowStone GRPC**: Use for sub-millisecond event monitoring.
- **Geyser Plugins**: Understanding how account updates stream into external databases.

### 3. Observability

- **Transaction Decoding**: Use `transaction-status` and `metadata` to parse complex CPI chains and inner instructions.
- **Monitoring**: Set up webhooks for specific account changes (e.g., liquidation thresholds).

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When architecting RPC layers, use `<think>` to:
>
> 1. Determine if a GRPC stream or a standard WebSocket is better for the latency requirement.
> 2. Calculate the rate-limit impact of polling vs. event-driven architectures.
> 3. Verify that the RPC provider supports the required method (e.g., `getAsset` for DAS).

## BEST PRACTICES

- Use `Commitment: Confirmed` for most UI updates; `Commitment: Finalized` ONLY for high-value financial settlements.
- Implement robust retry logic with exponential backoff for 429 (Rate Limit) errors.
