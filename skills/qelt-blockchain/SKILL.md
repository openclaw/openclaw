---
name: qelt-blockchain
description: "Query and interact with the QELT blockchain (Chain ID 770) via JSON-RPC. Use when asked about blocks, transactions, wallet balances, smart contract calls, gas estimation, event logs, nonces, or raw transaction submission. Covers QELT Mainnet (770) and Testnet (771)."
homepage: https://docs.qelt.ai
metadata: { "openclaw": { "emoji": "⛓️", "requires": { "bins": ["curl"] } } }
---

# QELT Blockchain Skill

QELT is an enterprise-grade EVM-compatible Layer-1 built on Hyperledger Besu 25.12.0 with QBFT consensus. Immediate finality in 5-second blocks. Zero base fee (~$0.002/tx).

**Mainnet:** Chain ID `770` · RPC `https://mainnet.qelt.ai`
**Testnet:** Chain ID `771` · RPC `https://testnet.qelt.ai`
**Archive (historical + TRACE):** `https://archivem.qelt.ai`

## Safety

- Never request, store, print, or transmit private keys or mnemonics.
- Write operations accept **pre-signed raw transactions only** (hex starting with `0x`).
- For historical/TRACE queries, use `https://archivem.qelt.ai`.
- Confirm mainnet vs testnet with the user before submitting transactions.
- Do not invent block numbers, hashes, or balances — always fetch live data.

## Endpoints

| Purpose | URL |
|---------|-----|
| Primary RPC (Mainnet) | `https://mainnet.qelt.ai` |
| Archive + TRACE (Mainnet) | `https://archivem.qelt.ai` |
| Testnet RPC | `https://testnet.qelt.ai` |
| Testnet Archive | `https://archive.qelt.ai` |
| Block Explorer | `https://qeltscan.ai` |
| Indexer API | `https://mnindexer.qelt.ai` |

## JSON-RPC Calls

All calls are standard Ethereum JSON-RPC 2.0 `POST` requests.

### Get Latest Block Number

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Parse `result` hex → `printf '%d\n' <hex>`.

### Get Block

```bash
# By number (hex): block 1000 = 0x3e8
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["0x3e8",true],"id":1}'

# By hash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBlockByHash","params":["0xHASH",true],"id":1}'
```

### Get Balance

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xADDRESS","latest"],"id":1}'
```

Divide `result` (wei, hex) by `10^18` for QELT.

### Get Transaction

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionByHash","params":["0xTX_HASH"],"id":1}'
```

### Get Transaction Receipt

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["0xTX_HASH"],"id":1}'
```

`status: "0x1"` = success · `status: "0x0"` = reverted.

### Call Smart Contract (Read-Only)

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xCONTRACT","data":"0xCALLDATA"},"latest"],"id":1}'
```

### Estimate Gas

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_estimateGas","params":[{"from":"0xFROM","to":"0xTO","data":"0xDATA","value":"0x0"}],"id":1}'
```

### Get Event Logs

Always bound the block range — querying from genesis (`"0x0"`) scans the entire chain and is commonly rate-limited or timed out. Use a recent window (e.g., last 1,000 blocks) and page forward if you need more history.

```bash
# First get the current block number
LATEST=$(curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")

# Then query a bounded recent range (last ~1000 blocks ≈ 83 minutes on QELT)
# Clamp at 0 so the start block is never negative on a low-height chain (e.g. fresh testnet).
FROM_HEX=$(python3 -c "latest=int('$LATEST',16); print(hex(max(0, latest - 1000)))")

curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$FROM_HEX\",\"toBlock\":\"latest\",\"address\":\"0xCONTRACT\",\"topics\":[\"0xTOPIC\"]}],\"id\":1}"
```

For full historical log scans, use `https://archivem.qelt.ai` and page in chunks of ≤10,000 blocks to avoid timeouts.

### Get Contract Code

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xCONTRACT","latest"],"id":1}'
```

`"0x"` = EOA · anything longer = deployed contract.

### Get Nonce

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["0xADDRESS","latest"],"id":1}'
```

### Send Pre-Signed Transaction

⚠️ **Write operation** — confirm with user before executing.

```bash
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0xSIGNED_TX_HEX"],"id":1}'
```

Returns the transaction hash on success.

### Chain Info

```bash
# Chain ID
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Gas price
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}'
```

## Network Reference

| Parameter | Mainnet | Testnet |
|-----------|---------|---------|
| Chain ID | 770 (0x302) | 771 (0x303) |
| RPC | `https://mainnet.qelt.ai` | `https://testnet.qelt.ai` |
| Archive | `https://archivem.qelt.ai` | `https://archive.qelt.ai` |
| Indexer | `https://mnindexer.qelt.ai` | `https://tnindexer.qelt.ai` |
| Block Time | 5 seconds | 5 seconds |
| Gas Limit | 50,000,000 | 50,000,000 |
| Base Fee | 0 | 0 |
| EVM | Cancun | Cancun |
| Testnet Faucet | — | `https://testnet.qeltscan.ai/faucet` |

## MetaMask Config (Mainnet)

```json
{
  "chainId": "0x302",
  "chainName": "QELT Mainnet",
  "nativeCurrency": { "name": "QELT", "symbol": "QELT", "decimals": 18 },
  "rpcUrls": ["https://mainnet.qelt.ai"],
  "blockExplorerUrls": ["https://qeltscan.ai"]
}
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `execution reverted` | Contract call failed | Check ABI encoding |
| `nonce too low` | Stale nonce | Fetch fresh nonce with `eth_getTransactionCount` |
| `insufficient funds` | No QELT for gas | Fund wallet or use testnet faucet |
| `unknown block` | Archive query on validator | Use `https://archivem.qelt.ai` |
| HTTP 429/503 | Rate limited | Exponential backoff |
