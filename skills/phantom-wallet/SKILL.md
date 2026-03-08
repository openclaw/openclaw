---
name: phantom-wallet
description: "Use when the user wants to interact with their Phantom crypto wallet — get wallet addresses, transfer SOL or SPL tokens on Solana, buy or swap tokens, sign transactions, or sign messages. Also use when the user asks about their crypto balances, wants to send crypto to someone, or needs to verify wallet ownership. Covers Solana, Ethereum, Bitcoin, and Sui chains via the Phantom MCP server (@phantom/mcp-server)."
homepage: https://docs.phantom.com
metadata:
  {
    "openclaw":
      {
        "emoji": "👻",
        "requires": { "env": ["PHANTOM_APP_ID"] },
        "primaryEnv": "PHANTOM_APP_ID",
        "install":
          [
            {
              "id": "phantom-mcp",
              "kind": "node",
              "package": "@phantom/mcp-server",
              "label": "Phantom MCP Server (npm)",
            },
          ],
      },
  }
---

# Phantom Wallet

Interact with the user's Phantom wallet via MCP tools — get addresses, transfer tokens, swap, sign transactions, and sign messages.

## Setup

The Phantom MCP server requires a `PHANTOM_APP_ID` environment variable from [Phantom Portal](https://portal.phantom.com). On first use, it opens a browser for OAuth authentication via Google or Apple login.

MCP config:

```json
{
  "mcpServers": {
    "phantom": {
      "command": "npx",
      "args": ["-y", "@phantom/mcp-server"],
      "env": { "PHANTOM_APP_ID": "<your-app-id>" }
    }
  }
}
```

## Available Tools

| Tool                   | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `get_wallet_addresses` | Get blockchain addresses (Solana, Ethereum, Bitcoin, Sui) for the connected wallet |
| `transfer_tokens`      | Transfer SOL or SPL tokens on Solana — builds, signs, and sends the transaction    |
| `buy_token`            | Fetch Solana swap quotes from Phantom API; optionally sign and send                |
| `sign_transaction`     | Sign a transaction (base64url for Solana, RLP hex for Ethereum)                    |
| `sign_message`         | Sign a UTF-8 message with automatic chain-specific routing                         |

## Supported Networks

| Chain    | Networks                                  | CAIP-2 Examples                           |
| -------- | ----------------------------------------- | ----------------------------------------- |
| Solana   | mainnet, devnet, testnet                  | `solana:mainnet`, `solana:devnet`         |
| Ethereum | Mainnet, Sepolia, Polygon, Base, Arbitrum | `eip155:1`, `eip155:137`                  |
| Bitcoin  | Mainnet                                   | `bip122:000000000019d6689c085ae165831e93` |
| Sui      | Mainnet, Testnet                          | `sui:mainnet`                             |

## Operations

### Get wallet addresses

Retrieve the user's wallet addresses across all supported chains:

```
Use get_wallet_addresses to list addresses.
Returns: array of { chain, network, address } objects.
```

### Transfer SOL

Send native SOL to a recipient:

```
Use transfer_tokens:
  token: "SOL"
  recipientAddress: "<recipient>"
  amount: "0.1"
  network: "solana:mainnet"
```

The MCP handles transaction building, signing, and submission.

### Transfer SPL tokens

Send any SPL token by its mint address:

```
Use transfer_tokens:
  token: "<token-mint-address>"
  recipientAddress: "<recipient>"
  amount: "10"
  network: "solana:mainnet"
```

### Buy / swap tokens

Get a swap quote and optionally execute:

```
Use buy_token:
  tokenMint: "<token-mint-to-buy>"
  amount: "1000000"  (in lamports for SOL input)
  network: "solana:mainnet"
```

Returns quote with price, fees, and slippage info. Can sign and send in one step.

### Sign a message

Sign a UTF-8 message for verification or authentication:

```
Use sign_message:
  message: "Hello, verifying ownership"
  network: "solana:mainnet"
```

Routes to the correct chain-specific signing based on the network parameter.

### Sign a raw transaction

Sign a pre-built transaction without sending:

```
Use sign_transaction:
  transaction: "<base64url-encoded-transaction>"
  network: "solana:mainnet"
```

Use base64url encoding for Solana, RLP hex for Ethereum.

## Important Notes

- **Preview software** — recommend using a separate wallet with minimal funds for testing
- Sessions persist locally in `~/.phantom-mcp/session.json`
- Token transfers on Solana support both native SOL and any SPL token
- Swap quotes come from Phantom's API and include fee and slippage info
- Always confirm amounts and recipients with the user before executing transfers

## Resources

- [Phantom Portal](https://portal.phantom.com) — App registration and `PHANTOM_APP_ID`
- [Phantom Docs](https://docs.phantom.com) — Full documentation
- [@phantom/mcp-server](https://www.npmjs.com/package/@phantom/mcp-server) — npm package
