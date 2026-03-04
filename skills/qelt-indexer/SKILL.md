---
name: qelt-indexer
description: "Query indexed QELT blockchain data via the Mainnet Indexer REST API — blocks, transactions, address history, token balances, and sync health. Use when asked about specific blocks or tx hashes, wallet transaction history, ERC-20 token balances, or indexer sync status. No API key required. Rate limit: 120 req/min."
homepage: https://mnindexer.qelt.ai
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["curl"] } } }
---

# QELT Indexer Skill

The QELT Mainnet Indexer is a high-performance REST API providing structured access to blockchain data — blocks, transactions, tokens, NFTs, and smart contracts — synced every 5 seconds.

**Base URL (Mainnet):** `https://mnindexer.qelt.ai`
**Base URL (Testnet):** `https://tnindexer.qelt.ai`
**Auth:** None required
**Rate Limit:** 120 req/min (standard `/v1/*` tier)

## Safety

- Read-only API — no write operations.
- Never fabricate block numbers, tx hashes, or balances — always fetch live data.
- Check indexer sync before reporting "latest" data: `GET /v1/health/ready` → `lag` field.
- Exponential backoff on HTTP 503 (`{"error": "Rate limit exceeded"}`).
- Use `limit` and `offset` for all list endpoints — avoid unbounded queries.

## Endpoints

### Blocks

```bash
# Latest block
curl -fsSL "https://mnindexer.qelt.ai/v1/blocks/latest"

# By number
curl -fsSL "https://mnindexer.qelt.ai/v1/blocks/1234567"

# By hash
curl -fsSL "https://mnindexer.qelt.ai/v1/blocks/0xHASH"

# Paginated list
curl -fsSL "https://mnindexer.qelt.ai/v1/blocks?limit=20&offset=0"
```

### Transactions

```bash
# By hash
curl -fsSL "https://mnindexer.qelt.ai/v1/transactions/0xTX_HASH"

# Receipt with logs
curl -fsSL "https://mnindexer.qelt.ai/v1/transactions/0xTX_HASH/receipt"
```

`status: 1` = success · `status: 0` = reverted.

### Addresses

```bash
# Transaction history (paginated)
curl -fsSL "https://mnindexer.qelt.ai/v1/address/0xADDRESS/transactions?limit=20&offset=0"

# ERC-20 token balances
curl -fsSL "https://mnindexer.qelt.ai/v1/address/0xADDRESS/tokens"

# All balances (native QELT + all tokens)
curl -fsSL "https://mnindexer.qelt.ai/v1/account/0xADDRESS/balances"
```

### Health and Sync Status

```bash
curl -fsSL "https://mnindexer.qelt.ai/v1/health/ready"
```

Response:

```json
{
  "indexerHeight": 896360,
  "blockchainHeight": 896360,
  "lag": 0,
  "timestamp": "2026-03-04T06:00:00.000Z"
}
```

`lag: 0` = fully synced · `lag > 100` = warn user that data may be stale.

## Response Shapes

### Block

```json
{
  "number": 1234567,
  "hash": "0x...",
  "parentHash": "0x...",
  "timestamp": 1705223340,
  "miner": "0x...",
  "gasUsed": "21000",
  "gasLimit": "50000000",
  "transactions": [...]
}
```

### Transaction

```json
{
  "hash": "0x...",
  "blockNumber": 1234567,
  "from": "0x...",
  "to": "0x...",
  "value": "1000000000000000000",
  "gasPrice": "0",
  "gasUsed": "21000",
  "status": 1,
  "timestamp": 1705223340
}
```

### Address Balances

```json
{
  "native": "1234.56",
  "tokens": [
    { "contractAddress": "0x...", "symbol": "USDT", "name": "Tether USD", "balance": "1000.5", "decimals": 6, "type": "ERC20" }
  ],
  "dataSource": "database_optimized"
}
```

## Procedure

### Look Up a Transaction

1. `GET /v1/transactions/{hash}`
2. Check `status`: 1 = success, 0 = reverted
3. Report: from, to, value (divide wei by 1e18 for QELT), timestamp, block number
4. For logs: `GET /v1/transactions/{hash}/receipt`

### Get Wallet History

1. Check sync: `GET /v1/health/ready` — warn if `lag > 100`
2. Fetch: `GET /v1/address/{address}/transactions?limit=20`
3. Format wei values: divide by 1e18 for QELT amounts

### Get Token Balances

1. Fetch: `GET /v1/account/{address}/balances`
2. Report native QELT + each ERC-20 with formatted balance

### Check Indexer Sync

1. Fetch: `GET /v1/health/ready`
2. `lag = blockchainHeight - indexerHeight`
3. If lag > 1000, recommend using JSON-RPC directly for real-time data

## Rate Limits

| Tier | Endpoints | Limit |
|------|-----------|-------|
| Standard | `/v1/*` | 120 req/min |
| Health | `/health*` | 120 req/min |
| Heavy | Complex queries | 60 req/min |
| General | Other | 30 req/min |

Rate limit exceeded → HTTP 503: `{"error": "Rate limit exceeded"}`

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| HTTP 503 | Rate limited | Exponential backoff |
| `{"error":"Transaction not found"}` | Hash wrong or not yet indexed | Wait for indexer sync |
| Empty `transactions: []` | No activity on address | Expected for new wallets |
| `lag > 1000` | Indexer behind | Use JSON-RPC for real-time |

## Testnet

Use `https://tnindexer.qelt.ai` with identical API paths for Chain ID 771 testnet data.
