---
name: vultisig-sdk
description: "Vultisig SDK for secure AI agent crypto operations. Sandboxed MPC signing without exposing seed phrases to AI context."
homepage: https://github.com/vultisig/vultisig-sdk
metadata: {"clawdbot":{"emoji":"🔐","requires":{"bins":["node","npx"]},"install":[{"id":"npm","kind":"npm","package":"@vultisig/sdk","bins":[],"label":"Install Vultisig SDK"}]}}
---

# Vultisig SDK

Secure crypto operations for AI agents using multi-party computation (MPC). The SDK provides sandboxed signing capabilities — agents get transaction signing ability without ever seeing private keys or seed phrases.

## Why This Matters for AI Agents

**Problem:** AI agents handling crypto need access to sign transactions, but:
- Seed phrases in AI context = security disaster
- Shared keys between human and AI = liability
- No audit trail of agent actions

**Solution:** Vultisig SDK provides:
- Sandboxed signing (agent signs, never sees keys)
- Separate agent identity (own vault, own keys)
- MPC threshold security (2-of-2 or N-of-M)
- Full audit trail of operations

## Installation

```bash
npm install @vultisig/sdk
# or
yarn add @vultisig/sdk
```

## Quick Start

### Initialize SDK

```typescript
import { Vultisig, MemoryStorage } from '@vultisig/sdk'

const sdk = new Vultisig({ storage: new MemoryStorage() })
await sdk.initialize()
```

### Fast Vault (Server-Assisted 2-of-2)

Best for: AI agent wallets, automated operations, quick setup

```typescript
// Create vault
const vaultId = await sdk.createFastVault({
  name: "Agent Wallet",
  email: "agent@example.com",
  password: "secure-password",
})

// Verify with email code
const vault = await sdk.verifyVault(vaultId, "123456")

// Get addresses
const btcAddress = await vault.address("Bitcoin")
const ethAddress = await vault.address("Ethereum")

// Sign transaction
const signedTx = await vault.sign(transactionPayload)
```

### Secure Vault (Multi-Device N-of-M)

Best for: High-value operations, team wallets, enhanced security

```typescript
const { vault } = await sdk.createSecureVault({
  name: "Team Wallet",
  devices: 3,  // 2-of-3 threshold
  onQRCodeReady: (qr) => displayQRCode(qr),
  onDeviceJoined: (id, total, required) => {
    console.log(`${total}/${required} devices ready`)
  }
})
```

## Supported Chains

Bitcoin, Ethereum, Cosmos, Solana, THORChain, and 40+ others including:
- EVM chains (Arbitrum, Optimism, Base, Polygon, BSC, Avalanche)
- Cosmos ecosystem (Osmosis, Dydx, Kujira, Maya)
- Others (Sui, Polkadot, Ton, Ripple)

## Common Operations

### Get Balances

```typescript
// Get all balances for a vault
const balances = await vault.balances()

// Get specific chain balance
const ethBalance = await vault.balance("Ethereum")
```

### Send Transaction

```typescript
// Simple send
await vault.send({
  chain: "Ethereum",
  to: "0x...",
  amount: "0.1",  // in native units
})
```

### Swap (via THORChain)

```typescript
// Cross-chain swap
await vault.swap({
  from: { chain: "Bitcoin", amount: "0.01" },
  to: { chain: "Ethereum" },
  slippage: 1,  // 1%
})
```

## Security Best Practices for AI Agents

### DO ✅
- Create a dedicated vault for the agent (separate identity)
- Use Fast Vault for automated operations
- Implement transaction limits in your agent logic
- Log all operations for audit trail
- Use allowlists for destination addresses

### DON'T ❌
- Never put seed phrases in AI context
- Never share vault credentials with users
- Never allow unlimited transaction amounts
- Never skip transaction verification

## Agent Integration Pattern

```typescript
// Recommended: Wrap SDK in an agent-safe interface
class AgentWallet {
  private vault: Vault
  private maxTxAmount: number
  private allowedAddresses: Set<string>

  async send(to: string, amount: string, chain: string) {
    // Validate against limits
    if (parseFloat(amount) > this.maxTxAmount) {
      throw new Error("Amount exceeds agent limit")
    }
    
    // Validate destination
    if (!this.allowedAddresses.has(to)) {
      throw new Error("Address not in allowlist")
    }

    // Execute with audit log
    console.log(`[AGENT TX] ${chain}: ${amount} -> ${to}`)
    return this.vault.send({ chain, to, amount })
  }
}
```

## Environment Variables

```bash
# Optional: Custom VultiServer endpoint
VULTISIG_SERVER_URL=https://api.vultisig.com

# Optional: Custom storage path
VULTISIG_STORAGE_PATH=~/.vultisig
```

## Resources

- [SDK Documentation](https://github.com/vultisig/vultisig-sdk)
- [Vultisig Website](https://vultisig.com)
- [API Reference](https://docs.vultisig.com)

## Troubleshooting

**"Vault not found"** — Verify vault ID and ensure verification completed

**"Signing failed"** — Check network connectivity to VultiServer

**"Chain not supported"** — Update SDK to latest version for new chain support
