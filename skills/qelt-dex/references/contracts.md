# Uniswap v4 Contract Addresses — QELT Mainnet

**Network:** QELT Mainnet | **Chain ID:** 770 | **Explorer:** https://qeltscan.ai

## Core Contracts

| Contract | Address | Verification |
|----------|---------|-------------|
| `PoolManager` | `0x11c23891d9f723c4f1c6560f892e4581d87b6d8a` | ✅ Verified |
| `Permit2` | `0x403cf2852cf448b5de36e865c5736a7fb7b25ea2` | ✅ Verified |

## Periphery Contracts

| Contract | Address | Verification |
|----------|---------|-------------|
| `UniversalRouter` | `0x7d5AbaDb17733963a3e14cF8fB256Ee08df9d68A` | ✅ Verified |
| `PositionManager` | `0x1809116b4230794c823b1b17d46c74076e90d035` | ✅ Verified |
| `PositionDescriptor` | `0x9bb9a0bac572ac1740eeadbedb97cddb497c57f0` | ✅ Verified |

## Utility Contracts

| Contract | Address | Verification |
|----------|---------|-------------|
| `WQELT` (Wrapped QELT) | `0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2` | ✅ Verified |
| `UnsupportedProtocol` | `0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E` | ✅ Verified |

## UniversalRouter Configuration

```javascript
const ROUTER_PARAMETERS = {
  permit2:              '0x403cF2852Cf448b5DE36e865c5736A7Fb7B25Ea2',
  weth9:                '0xfEbC6f9F0149036006C4F5Ac124685E0EF48e8A2', // WQELT
  v2Factory:            '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E', // UnsupportedProtocol
  v3Factory:            '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E', // UnsupportedProtocol
  v4PoolManager:        '0x11C23891d9F723c4F1c6560f892E4581D87B6d8a',
  v3NFTPositionManager: '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E', // UnsupportedProtocol
  v4PositionManager:    '0x1809116b4230794C823B1b17d46c74076e90D035',
  spokePool:            '0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E'  // UnsupportedProtocol
};
```

## Important Notes

- QELT **only supports Uniswap V4** — V2 and V3 calls revert with `UnsupportedProtocol`
- `UnsupportedProtocol` is a compatibility stub at `0xe4F095537EB1b0dd9C244e827B3E35171d5c2A6E`
- Use `WQELT` as `weth9` in all SDK configurations
- All 7 contracts are source-verified on QELTScan

## Explorer Links

- [PoolManager](https://qeltscan.ai/address/0x11c23891d9f723c4f1c6560f892e4581d87b6d8a)
- [UniversalRouter](https://qeltscan.ai/address/0x7d5AbaDb17733963a3e14cF8fB256Ee08df9d68A)
- [PositionManager](https://qeltscan.ai/address/0x1809116b4230794c823b1b17d46c74076e90d035)
- [Permit2](https://qeltscan.ai/address/0x403cf2852cf448b5de36e865c5736a7fb7b25ea2)
- [WQELT](https://qeltscan.ai/address/0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2)
