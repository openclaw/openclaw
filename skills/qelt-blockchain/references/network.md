# QELT Network Reference

## Mainnet (Chain ID 770)

| Parameter | Value |
|-----------|-------|
| Network Name | QELT Mainnet |
| Chain ID | 770 (0x302) |
| Token Symbol | QELT |
| Token Decimals | 18 |
| Consensus | QBFT (Quorum Byzantine Fault Tolerance) |
| Block Time | 5 seconds |
| Block Gas Limit | 50,000,000 |
| Base Fee | 0 (zero base fee) |
| EVM Version | Cancun |
| Client | Hyperledger Besu 25.12.0 |

### Mainnet RPC Endpoints

| Node | URL | Notes |
|------|-----|-------|
| Archive Node | `https://archivem.qelt.ai` | **Recommended** — full history + TRACE API |
| Validator 1 (Bootnode) | `https://mainnet.qelt.ai` | Primary |
| Validator 2 | `https://mainnet2.qelt.ai` | |
| Validator 3 | `https://mainnet3.qelt.ai` | |
| Validator 4 | `https://mainnet4.qelt.ai` | |
| Validator 5 | `https://mainnet5.qelt.ai` | |
| Indexer API | `https://mnindexer.qelt.ai` | REST API for queries |
| Block Explorer | `https://qeltscan.ai` | |

### MetaMask Configuration (Mainnet)

```json
{
  "chainId": "0x302",
  "chainName": "QELT Mainnet",
  "nativeCurrency": {
    "name": "QELT",
    "symbol": "QELT",
    "decimals": 18
  },
  "rpcUrls": ["https://mainnet.qelt.ai"],
  "blockExplorerUrls": ["https://qeltscan.ai"]
}
```

---

## Testnet (Chain ID 771)

| Parameter | Value |
|-----------|-------|
| Network Name | QELT Testnet |
| Chain ID | 771 (0x303) |
| Token Symbol | QELT |
| Token Decimals | 18 |
| Faucet | `https://testnet.qeltscan.ai/faucet` (2 QELT/day) |

### Testnet Endpoints

| Node | URL | Notes |
|------|-----|-------|
| Primary RPC | `https://testnet.qelt.ai` | Recommended |
| Archive RPC | `https://archive.qelt.ai` | Full history + TRACE |
| WebSocket | `wss://ws.qelt.ai` | Live events |
| Block Explorer | `https://testnet.qeltscan.ai` | |
| Faucet | `https://testnet.qeltscan.ai/faucet` | |
| Indexer | `https://tnindexer.qelt.ai` | REST API |

### MetaMask Configuration (Testnet)

```json
{
  "chainId": "0x303",
  "chainName": "QELT Testnet",
  "nativeCurrency": {
    "name": "QELT",
    "symbol": "QELT",
    "decimals": 18
  },
  "rpcUrls": ["https://testnet.qelt.ai"],
  "blockExplorerUrls": ["https://testnet.qeltscan.ai"]
}
```

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Block Time | 5 seconds |
| Theoretical TPS | 476 |
| Blocks per Day | 17,280 |
| Uptime | 99.9%+ |
| P2P Latency | < 100 ms |
| RPC Response | 50–200 ms |
| Transaction Finality | ~5 seconds (immediate with QBFT) |

## Consensus Architecture

- **Algorithm:** QBFT (Quorum Byzantine Fault Tolerance)
- **Validators:** 5 nodes
- **Byzantine Tolerance:** 1 malicious validator (⌊(5-1)/3⌋ = 1)
- **Min for Consensus:** 4 of 5 validators (⅔ + 1)
- **Block Period:** 5 seconds (`blockperiodseconds: 5`)
- **Epoch Length:** 30,000 blocks
- **Request Timeout:** 10 seconds

## Key Properties

- **Immediate Finality:** No chain reorganizations — transactions are final at block inclusion
- **Zero Base Fee:** `eth_gasPrice` returns 0; minimum effective gas price is 1,000 wei
- **EVM Cancun:** Supports all Cancun opcodes including `TSTORE`, `TLOAD`, `BLOBHASH`
- **No Mining:** Pure BFT, no proof-of-work
