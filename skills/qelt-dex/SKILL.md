---
name: qelt-dex
description: "Interact with Uniswap v4 pools and liquidity positions on QELT Mainnet. Use when asked about DEX pools, token swaps, liquidity provision, WQELT wrapping/unwrapping, pool state queries, position NFTs, or Uniswap v4 contract addresses. QELT only supports Uniswap V4 — V2/V3 calls revert."
homepage: https://qeltscan.ai
metadata: { "openclaw": { "emoji": "🔁", "requires": { "bins": ["curl"] } } }
---

# QELT DEX Skill (Uniswap v4)

QELT Mainnet hosts a fully deployed and verified Uniswap v4 instance. All 7 contracts are verified on QELTScan. Only Uniswap V4 is supported — V2/V3 calls route to `UnsupportedProtocol` and revert.

**Network:** QELT Mainnet · Chain ID `770`
**RPC:** `https://mainnet.qelt.ai`

## Safety

- Never request or handle private keys. Write operations require a **pre-signed raw transaction**.
- Swaps and liquidity changes are irreversible — confirm parameters with the user first.
- Always apply slippage protection (minimum 1% tolerance on `amountOutMin`).
- QELT only supports Uniswap V4. V2/V3 calls will revert.
- WQELT is the required ERC-20 wrapper for native QELT when trading on the DEX.

## Contract Addresses (Mainnet, Chain ID 770)

| Contract | Address | Role |
|----------|---------|------|
| `PoolManager` | `0x11c23891d9f723c4f1c6560f892e4581d87b6d8a` | Core — manages all pools |
| `UniversalRouter` | `0x7d5AbaDb17733963a3e14cF8fB256Ee08df9d68A` | Swap routing + aggregation |
| `PositionManager` | `0x1809116b4230794c823b1b17d46c74076e90d035` | Liquidity positions as NFTs |
| `Permit2` | `0x403cf2852cf448b5de36e865c5736a7fb7b25ea2` | Gasless approvals |
| `WQELT` | `0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2` | Wrapped QELT (ERC-20) |
| `PositionDescriptor` | `0x9bb9a0bac572ac1740eeadbedb97cddb497c57f0` | NFT metadata |
| `UnsupportedProtocol` | `0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E` | V2/V3 stub (reverts) |

## Procedure

### Query Contract Addresses

Return the table above from memory — no RPC call needed.

### Check WQELT Balance

```bash
WQELT="0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2"
ADDR="0xUSER_ADDRESS_WITHOUT_0x"

# balanceOf(address) selector: 0x70a08231
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$WQELT\",\"data\":\"0x70a08231000000000000000000000000$ADDR\"},\"latest\"],\"id\":1}"
```

Divide hex result by `10^18` for WQELT balance.

### Query Pool State

Pool state requires two `eth_call`s to PoolManager using ABI-encoded `getSlot0(bytes32)` and `getLiquidity(bytes32)`.

Pool ID = `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`

```bash
POOL_MANAGER="0x11c23891d9f723c4f1c6560f892e4581d87b6d8a"

# getSlot0(bytes32 poolId) — returns sqrtPriceX96, tick, protocolFee, lpFee
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$POOL_MANAGER\",\"data\":\"0x<ABI_ENCODED_getSlot0_POOLID>\"},\"latest\"],\"id\":1}"
```

**Slot0 decode:** `sqrtPriceX96` (current price), `tick` (current tick), `lpFee` (0.3% = 3000).

### Wrap QELT → WQELT

⚠️ Write operation — confirm with user. Requires pre-signed tx calling `deposit()` on WQELT with `value = amount_wei`.

```bash
# Submit pre-signed transaction
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0xSIGNED_TX_HEX"],"id":1}'
```

WQELT `deposit()` selector: `0xd0e30db0` · `withdraw(uint256)` selector: `0x2e1a7d4d`

### Token Swap via UniversalRouter

⚠️ Write operation — confirm with user. Requires pre-signed tx via `UniversalRouter.execute(commands, inputs, deadline)`.

Flow: Approve token → Permit2 → Permit2 approve → UniversalRouter → encode `V4_SWAP_EXACT_IN` command → call `execute`.

## Pool Key Structure

```
PoolKey {
  currency0: address  // lower address (or address(0) for native QELT)
  currency1: address  // higher address
  fee: uint24         // 3000 = 0.3%, 500 = 0.05%, 10000 = 1%
  tickSpacing: int24  // 60 for 0.3% fee tier
  hooks: address      // address(0) for no hooks
}
```

Common fee tiers:

| Fee | % | Tick Spacing | Use Case |
|-----|---|-------------|---------|
| 100 | 0.01% | 1 | Stablecoin pairs |
| 500 | 0.05% | 10 | Correlated assets |
| 3000 | 0.30% | 60 | Most pairs |
| 10000 | 1.00% | 200 | Volatile/exotic |

## WQELT Token

- **Address:** `0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2`
- **Ratio:** 1 WQELT = 1 QELT (always, no fee)
- **Wrap:** Call `deposit()` with ETH value = QELT amount
- **Unwrap:** Call `withdraw(uint256 amount)` to recover native QELT

## UniversalRouter Config

```javascript
{
  permit2:         '0x403cF2852Cf448b5DE36e865c5736A7Fb7B25Ea2',
  weth9:           '0xfEbC6f9F0149036006C4F5Ac124685E0EF48e8A2', // WQELT
  v4PoolManager:   '0x11C23891d9F723c4F1c6560f892E4581D87B6d8a',
  v4PositionManager: '0x1809116b4230794C823B1b17d46c74076e90D035',
  // V2/V3 addresses all point to UnsupportedProtocol:
  v2Factory:       '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E',
  v3Factory:       '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E',
}
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `UnsupportedProtocol` | V2/V3 call attempted | Use V4 path only |
| Slippage exceeded | Price moved | Increase `amountOutMin` tolerance |
| Deadline exceeded | Slow broadcast | Use `now + 1800` seconds |
| Permit2 signature expired | Approval timeout | Re-sign with fresh deadline |
