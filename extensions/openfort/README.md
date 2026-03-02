# Openfort Extension for OpenClaw

Let your OpenClaw agents send USDC without needing ETH for gas.

## What This Gives You

- 💵 **Send USDC** - Your agent can send stablecoins to any address
- ⛽ **No ETH needed** - Gas fees paid automatically in USDC
- 🔐 **Secure** - Keys managed by Openfort, no private keys in your config
- 🚀 **Works immediately** - No manual setup of policies or contracts

## Quick Start

### 1. Get API Keys

Sign up at [Openfort Dashboard](https://dashboard.openfort.io) and get:

- API Secret Key (starts with `sk_test_...`)
- Wallet Secret

### 2. Add to OpenClaw Config

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openfort": {
        "enabled": true,
        "config": {
          "secretKey": "sk_test_...",
          "walletSecret": "..."
        }
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

### 4. Try It

Ask your agent:

- "What's my wallet address?"
- "What's my USDC balance?"
- "Send 5 USDC to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e"

**That's it.** The extension automatically handles everything - wallet creation, gas sponsorship setup, and USDC transactions.

## How Gas Payment Works

Traditional crypto wallets require ETH (or native tokens) to pay transaction fees. This creates a chicken-and-egg problem: you need ETH to do anything, but getting ETH requires already having ETH for gas.

This extension solves that:

- **Before**: Wallet needs ETH → Buy ETH → Pay gas in ETH → Send USDC
- **After**: Just send USDC → Gas paid in USDC automatically → No ETH ever needed

Your wallet can operate with **zero ETH balance**.

## Configuration Options

| Option                 | Required | Default      | Description                                   |
| ---------------------- | -------- | ------------ | --------------------------------------------- |
| `secretKey`            | Yes      | -            | Openfort API key (get from dashboard)         |
| `walletSecret`         | Yes      | -            | Wallet encryption secret (get from dashboard) |
| `network`              | No       | base-sepolia | `base` (mainnet) or `base-sepolia` (testnet)  |
| `enableFeeSponsorship` | No       | true         | Set to `false` to use ETH for gas instead     |

### Use ETH for Gas (Optional)

If you prefer traditional gas payment with ETH:

```json
{
  "plugins": {
    "entries": {
      "openfort": {
        "enabled": true,
        "config": {
          "secretKey": "sk_test_...",
          "walletSecret": "...",
          "enableFeeSponsorship": false
        }
      }
    }
  }
}
```

## Security

### Restrict What Your Agent Can Do

Set up [Openfort Policies](https://www.openfort.io/docs/configuration/policies) in your dashboard to:

- Limit transaction amounts per day/week/month
- Whitelist approved recipient addresses
- Block certain contracts or tokens
- Set maximum gas costs

Policies enforce restrictions at the API level, independent of OpenClaw's tool permissions.

### How Keys Are Managed

- **Private keys**: Stored in Openfort's Trusted Execution Environment (TEE), never in your config
- **Wallet secret**: Required for signing, but keys never leave Openfort servers
- **API key**: Standard authentication, can be rotated anytime

## Networks

- **Base Sepolia** (testnet) - Free testnet USDC from [Circle faucet](https://faucet.circle.com/)
- **Base** (mainnet) - Production use with real USDC

Both support USDC gas payment.

## Rate Limits

USDC gas sponsorship has usage limits based on your Openfort plan. See [Openfort Pricing](https://www.openfort.io/pricing) for details.

## Troubleshooting

### Common Implementation Pitfalls

If you're building similar integrations or debugging issues, avoid these mistakes:

#### ❌ Wrong: Manual EIP-7702 Authorization Hash

```typescript
// DON'T do this - produces incorrect hash
const authHash = keccak256(concat(["0x05", rlp([chainId, address, nonce])]));
```

#### ✅ Correct: Use viem's hashAuthorization

```typescript
// DO this - handles EIP-7702 encoding correctly
import { hashAuthorization } from "viem/utils";
const authHash = hashAuthorization({
  contractAddress: CALIBUR_IMPLEMENTATION,
  chainId: this.chain.id,
  nonce: eoaNonce,
});
```

**Why?** EIP-7702 has specific encoding rules that differ from standard RLP encoding. Viem's utility implements the exact specification.

#### USDC Contract ABI

The standard `erc20Abi` from viem works perfectly with USDC, even though USDC uses the FiatTokenV2_2 implementation behind a proxy. All standard ERC20 methods (`balanceOf`, `transfer`, `approve`) are transparently available.

You don't need the full FiatTokenV2_2 ABI unless you're using USDC-specific features like pausability or blacklisting.

## Learn More

- [Openfort Documentation](https://www.openfort.io/docs)
- [Get API Keys](https://dashboard.openfort.io)
- [Policies Guide](https://www.openfort.io/docs/configuration/policies)
- [Fee Sponsorship](https://www.openfort.io/docs/configuration/gas-sponsorship)
- [EIP-7702 Specification](https://eips.ethereum.org/EIPS/eip-7702)
