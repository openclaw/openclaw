# Sign and Submit API Reference

Synchronous endpoints for signing messages and submitting transactions directly.

## Overview

Unlike the async prompt endpoint, these endpoints are **synchronous** and return immediately:

| Endpoint | Purpose | Returns |
|----------|---------|---------|
| `POST /agent/sign` | Sign messages, typed data, or transactions | Signature |
| `POST /agent/submit` | Submit raw transactions to chain | Transaction hash |

## POST /agent/sign

Sign data without broadcasting to the network.

### Supported Signature Types

| Type | Use Case |
|------|----------|
| `personal_sign` | Sign plain text messages (auth, verification) |
| `eth_signTypedData_v4` | Sign EIP-712 typed data (permits, orders) |
| `eth_signTransaction` | Sign transactions for later broadcast |

### Request Examples

#### personal_sign

```bash
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "signatureType": "personal_sign",
    "message": "Sign in to MyApp\nNonce: abc123"
  }'
```

#### eth_signTypedData_v4

```bash
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "signatureType": "eth_signTypedData_v4",
    "typedData": {
      "domain": {
        "name": "USD Coin",
        "version": "2",
        "chainId": 8453,
        "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      },
      "types": {
        "Permit": [
          { "name": "owner", "type": "address" },
          { "name": "spender", "type": "address" },
          { "name": "value", "type": "uint256" },
          { "name": "nonce", "type": "uint256" },
          { "name": "deadline", "type": "uint256" }
        ]
      },
      "primaryType": "Permit",
      "message": {
        "owner": "0xYourAddress",
        "spender": "0xSpenderAddress",
        "value": "1000000",
        "nonce": "0",
        "deadline": "1735689600"
      }
    }
  }'
```

#### eth_signTransaction

```bash
curl -X POST "https://api.bankr.bot/agent/sign" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "signatureType": "eth_signTransaction",
    "transaction": {
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "chainId": 8453,
      "value": "0",
      "data": "0xa9059cbb..."
    }
  }'
```

### Success Response (200 OK)

```json
{
  "success": true,
  "signature": "0x...",
  "signer": "0xYourWalletAddress",
  "signatureType": "personal_sign"
}
```

### Error Responses

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `signatureType is required` | Missing signature type |
| 400 | `message is required for personal_sign` | Missing message field |
| 400 | `typedData is required for eth_signTypedData_v4` | Missing typed data |
| 400 | `transaction is required for eth_signTransaction` | Missing transaction |
| 401 | `Authentication required` | Missing or invalid API key |
| 403 | `Agent API access not enabled` | API key lacks agent access |

## POST /agent/submit

Submit raw transactions directly to the blockchain.

### Request Body

```json
{
  "transaction": {
    "to": "0x...",
    "chainId": 8453,
    "value": "1000000000000000000",
    "data": "0x..."
  },
  "description": "Transfer 1 ETH",
  "waitForConfirmation": true
}
```

### Transaction Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Destination address |
| `chainId` | number | Yes | Chain ID (8453=Base, 1=Ethereum, 137=Polygon) |
| `value` | string | No | Value in wei (as string) |
| `data` | string | No | Calldata (hex string) |
| `gas` | string | No | Gas limit |
| `gasPrice` | string | No | Legacy gas price |
| `maxFeePerGas` | string | No | EIP-1559 max fee |
| `maxPriorityFeePerGas` | string | No | EIP-1559 priority fee |
| `nonce` | number | No | Transaction nonce |

### Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | - | Human-readable description for logging |
| `waitForConfirmation` | boolean | `true` | Wait for on-chain confirmation |

### Request Examples

#### Simple ETH Transfer

```bash
curl -X POST "https://api.bankr.bot/agent/submit" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": {
      "to": "0xRecipientAddress",
      "chainId": 8453,
      "value": "1000000000000000000"
    },
    "description": "Send 1 ETH"
  }'
```

#### ERC20 Transfer

```bash
curl -X POST "https://api.bankr.bot/agent/submit" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": {
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "chainId": 8453,
      "value": "0",
      "data": "0xa9059cbb000000000000000000000000recipient000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4240"
    },
    "description": "Transfer USDC"
  }'
```

#### Fire-and-Forget

```bash
curl -X POST "https://api.bankr.bot/agent/submit" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": {
      "to": "0xRecipientAddress",
      "chainId": 8453,
      "value": "100000000000000000"
    },
    "waitForConfirmation": false
  }'
```

### Success Response (200 OK)

With confirmation (`waitForConfirmation: true`):

```json
{
  "success": true,
  "transactionHash": "0x...",
  "status": "success",
  "blockNumber": "12345678",
  "gasUsed": "21000",
  "signer": "0xYourWalletAddress",
  "chainId": 8453
}
```

Without confirmation (`waitForConfirmation: false`):

```json
{
  "success": true,
  "transactionHash": "0x...",
  "status": "pending",
  "signer": "0xYourWalletAddress",
  "chainId": 8453
}
```

### Transaction Status Values

| Status | Description |
|--------|-------------|
| `success` | Transaction confirmed and succeeded |
| `reverted` | Transaction confirmed but reverted |
| `pending` | Transaction submitted, not yet confirmed |

### Error Responses

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `transaction object is required` | Missing transaction |
| 400 | Submission failed | Insufficient funds, gas estimation failed, etc. |
| 401 | `Authentication required` | Missing or invalid API key |
| 403 | `Agent API access not enabled` | API key lacks agent access |

## Use Cases

### Authentication (Sign)

Use `personal_sign` to verify wallet ownership:

```json
{
  "signatureType": "personal_sign",
  "message": "Sign in to MyApp\n\nNonce: xyz789\nTimestamp: 2025-01-26T10:00:00Z"
}
```

### Gasless Approvals (Sign)

Use `eth_signTypedData_v4` for EIP-2612 permits:

```json
{
  "signatureType": "eth_signTypedData_v4",
  "typedData": { /* permit struct */ }
}
```

### Pre-Built Transactions (Submit)

Submit transactions built by external tools:

```javascript
const tx = await buildSwapTransaction();
await fetch('https://api.bankr.bot/agent/submit', {
  method: 'POST',
  headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transaction: tx })
});
```

### Multi-Step Workflows (Submit)

Execute approve + swap in sequence:

```javascript
// 1. Approve
await submit({ transaction: approveTx });

// 2. Swap
await submit({ transaction: swapTx });
```

## Comparison

| Feature | /agent/prompt | /agent/sign | /agent/submit |
|---------|---------------|-------------|---------------|
| Input | Natural language | Structured data | Transaction object |
| Response | Async (job ID) | Sync (signature) | Sync (tx hash) |
| Executes on-chain | Via AI agent | No | Yes |
| Best for | General queries | Auth, permits | Raw transactions |

## Security Notes

- API keys with agent access can submit transactions — keep them secure
- The `submit` endpoint has no confirmation prompts — it executes immediately
- Validate all transaction parameters before submission
- Consider using `waitForConfirmation: true` for important transactions

---

**Full documentation**: [docs.bankr.bot/agent-api](https://docs.bankr.bot/agent-api/overview)
