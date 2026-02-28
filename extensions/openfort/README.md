# Openfort Extension for OpenClaw

Backend wallet integration with EIP-7702 support and USDC gas sponsorship for OpenClaw agents.

## Features

- ✅ Backend wallet management (no private key handling)
- ✅ EIP-7702 delegated accounts (EOA → Smart Account)
- ✅ USDC gas payment (pay transaction fees in USDC, not ETH)
- ✅ Dynamic fee sponsorship
- ✅ Multi-network support (Base, Base Sepolia)

## Setup

1. Get your credentials from [Openfort Dashboard](https://dashboard.openfort.xyz):
   - API Secret Key (starts with `sk_live_` or `sk_test_`)
   - Wallet Secret (base64 encoded key)

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

## Available Tools

### `openfort_get_wallet_address`

Get the address of the backend wallet.

### `openfort_sign_message`

Sign a message with the wallet (EIP-191).

**Parameters:**

- `message` (string): The message to sign

### `openfort_get_balance`

Get the ETH and USDC balances of the wallet.

### `openfort_send_eth`

Send ETH from the wallet.

**Parameters:**

- `to` (string): Recipient address
- `amount` (string): Amount in ETH (e.g., "0.001")

### `openfort_send_usdc`

Send USDC from the wallet.

**Parameters:**

- `to` (string): Recipient address
- `amount` (string): Amount in USDC (e.g., "10.50")

### `openfort_list_accounts`

List all backend wallet accounts.

**Parameters:**

- `limit` (number, optional): Maximum number of accounts (default: 10)

## EIP-7702 & USDC Gas Payment

This extension supports EIP-7702 delegated accounts, allowing EOAs to act as smart accounts with features like:

- **Gas payment in USDC instead of ETH** (0 ETH required)
- Batch transactions
- Session keys
- Paymaster sponsorship via Openfort

### How It Works

1. **Create Backend Wallet** - Openfort manages the wallet securely
2. **Upgrade to Delegated Account** - Convert EOA to smart account via EIP-7702
3. **Setup Fee Sponsorship** - Configure dynamic USDC gas payment policy
4. **Send Transactions** - Pay gas in USDC automatically

### Working Example

The extension implements EIP-7702 support for USDC gas payment:

- Creates EIP-7702 authorization using `hashAuthorization` from viem
- Signs authorization with backend wallet
- Creates transaction intent with `signedAuthorization`
- Signs user operation and submits transaction via Openfort
- **Result**: USDC transfer with gas paid in USDC, 0 ETH used

**Proven Transaction**: [0x361a41b39cbf2de17546f015fafdcd962b619b7f332baac34c207ab66a723e85](https://sepolia.basescan.org/tx/0x361a41b39cbf2de17546f015fafdcd962b619b7f332baac34c207ab66a723e85)

## Networks

Supported networks:

- `base-sepolia` (testnet, default)
- `base` (mainnet)

## Testing

After setup, you can test by sending messages to your OpenClaw agent:

- "What's my Openfort wallet address?"
- "Get my wallet balance"
- "Sign the message: Hello World"
- "Send 0.5 USDC to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
- "List my Openfort accounts"

## Structure

```
openfort/
├── index.ts                          # Main plugin entry point
├── package.json                      # Dependencies (@openfort/openfort-node, viem)
├── README.md                         # This file
│
└── src/                              # Core source code
    ├── types.ts                      # TypeScript interfaces & types
    ├── constants.ts                  # Network constants & addresses
    ├── client.ts                     # OpenfortClient wrapper class
    ├── tools.ts                      # Tool implementations (6 tools)
    └── utils.ts                      # Type-safe utility functions
```

## Development

### TypeScript Best Practices

This extension follows strict TypeScript best practices:

✅ **No unsafe type casts** - Uses validation functions instead of `as`

```typescript
// ❌ Bad
const address = input.to as Address;

// ✅ Good
const address = toAddress(input.to); // Validates and throws if invalid
```

✅ **Proper type definitions** - Separate types for API responses vs internal usage

```typescript
OpenfortAccountRaw; // Raw API response from Openfort
AccountInfo; // Typed internal representation
```

✅ **Validation before conversion** - Always validate external data

```typescript
export function toAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid Ethereum address: ${value}`);
  }
  return value;
}
```

### Adding New Tools

1. Add types to `src/types.ts`
2. Add tool implementation to `src/tools.ts`
3. Use `toAddress()` for address validation
4. Update README with tool documentation

## Documentation

- [Openfort Documentation](https://www.openfort.io/docs)
- [EIP-7702 Guide](https://www.openfort.io/docs/recipes/7702)
- [Fee Sponsorship](https://dashboard.openfort.xyz/fee-sponsorships)
- [Viem Documentation](https://viem.sh)
