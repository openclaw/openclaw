# QELT Indexer API — Quick Reference

## Base URLs

| Network | Base URL |
|---------|----------|
| Mainnet | `https://mnindexer.qelt.ai` |
| Testnet | `https://tnindexer.qelt.ai` |

## Blocks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/blocks/latest` | Latest block with transactions |
| GET | `/v1/blocks/:blockId` | Block by number or hash |
| GET | `/v1/blocks?limit=10&offset=0` | Paginated block list |

## Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/transactions/:hash` | Transaction by hash |
| GET | `/v1/transactions/:hash/receipt` | Transaction receipt with logs |

## Addresses

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/address/:address/transactions` | Address transaction history |
| GET | `/v1/address/:address/tokens` | ERC-20 token balances |
| GET | `/v1/account/:address/balances` | Native + token balances |

## Contract Verification

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/verification/submit` | Single-file verification |
| POST | `/api/v1/verification/submit-multi` | Multi-file verification |
| GET | `/api/v1/verification/status/:jobId` | Poll verification status |
| GET | `/api/v2/contracts/:address/verification` | Get verified contract |
| GET | `/api/v2/verification/compiler-versions` | List Solidity versions |
| GET | `/api/v2/verification/evm-versions` | List EVM versions |

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/health/ready` | Sync status and block lag |

## Rate Limits

| Tier | Endpoints | Limit |
|------|-----------|-------|
| Standard | `/v1/*` | 120 req/min (burst: 20) |
| Health | `/health*` | 120 req/min (burst: 20) |
| Heavy | Complex queries | 60 req/min (burst: 10) |
| General | Other | 30 req/min (burst: 5) |

Rate limit exceeded → HTTP 503: `{"error": "Rate limit exceeded"}`

## Block Response Shape

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

## Transaction Response Shape

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

## Receipt Response Shape

```json
{
  "transactionHash": "0x...",
  "blockNumber": 1234567,
  "status": 1,
  "gasUsed": "65000",
  "logs": [
    {
      "address": "0x...",
      "topics": ["0x..."],
      "data": "0x..."
    }
  ]
}
```

## Health Response Shape

```json
{
  "indexerHeight": 896360,
  "blockchainHeight": 896360,
  "lag": 0,
  "timestamp": "2026-03-04T06:00:00.000Z"
}
```

## Address Balances Response Shape

```json
{
  "native": "1234.56",
  "tokens": [
    {
      "contractAddress": "0x...",
      "symbol": "USDT",
      "name": "Tether USD",
      "balance": "1000.5",
      "decimals": 6,
      "type": "ERC20"
    }
  ],
  "dataSource": "database_optimized"
}
```
