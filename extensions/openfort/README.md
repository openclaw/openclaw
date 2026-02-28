# Openfort Extension for OpenClaw

Give your OpenClaw agents the ability to send stablecoins with gas sponsorship.

## What This Does

- 💵 **Send USDC** - Agents can send USDC to any address
- ⛽ **Gas Sponsorship** - Pay transaction fees in USDC instead of ETH (no ETH needed)
- 🔐 **Secure Backend Wallets** - Openfort manages keys securely, no private key handling

## Setup

1. Get your credentials from [Openfort Dashboard](https://dashboard.openfort.io):
   - API Secret Key (starts with `sk_live_` or `sk_test_`)
   - Wallet Secret

2. Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "openfort": {
        "enabled": true,
        "secretKey": "sk_test_...",
        "walletSecret": "MIGHAgEA...",
        "network": "base-sepolia"
      }
    }
  }
}
```

3. Restart OpenClaw gateway

## Usage

Once configured, your agent can:

- **Send USDC**: "Send 10 USDC to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
- **Check balance**: "What's my wallet balance?"
- **Get address**: "What's my wallet address?"

Gas fees are automatically paid in USDC - no ETH needed.

## How It Works

Openfort provides:

- **Backend wallets** - Secure key management, no private keys in your config
- **Gas sponsorship** - Pay transaction fees in USDC instead of ETH
- **Multi-network support** - Base mainnet and Base Sepolia testnet

[View working transaction on Base Sepolia](https://sepolia.basescan.org/tx/0x361a41b39cbf2de17546f015fafdcd962b619b7f332baac34c207ab66a723e85)

## Documentation

- [Openfort Documentation](https://www.openfort.io/docs)
- [Get API Keys](https://dashboard.openfort.io)
