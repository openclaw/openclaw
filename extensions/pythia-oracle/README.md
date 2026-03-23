# Pythia Oracle

Adds a native `consult_oracle` agent tool backed by the remote Pythia MCP service.

Features:

- Direct tool call without an external MCP bridge process
- x402 payment support using a server-side Base wallet
- In-channel approval prompts that reuse OpenClaw's existing `/approve` flow
- Per-agent spend tracking and optional allow-always grants

Recommended config:

```json5
{
  plugins: {
    entries: {
      "pythia-oracle": {
        enabled: true,
        config: {
          walletPrivateKeyEnvVar: "PYTHIA_BASE_PRIVATE_KEY",
          dailyBudgetUsd: 1,
          expectedPriceUsd: 0.025,
        },
      },
    },
  },
}
```

The wallet private key should come from a dedicated Base USDC wallet, not from a personal hot wallet.
