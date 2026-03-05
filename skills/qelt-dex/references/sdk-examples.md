# Uniswap v4 SDK Examples — QELT Mainnet

> These examples use ethers.js v6 and the Uniswap Universal Router SDK.
> For pre-signing transactions offline, use these patterns then pass the raw hex to the skill.

## Setup

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://mainnet.qelt.ai');
// Chain ID: 770

const CONTRACTS = {
  poolManager:      '0x11c23891d9f723c4f1c6560f892e4581d87b6d8a',
  universalRouter:  '0x7d5AbaDb17733963a3e14cF8fB256Ee08df9d68A',
  positionManager:  '0x1809116b4230794c823b1b17d46c74076e90d035',
  permit2:          '0x403cf2852cf448b5de36e865c5736a7fb7b25ea2',
  wqelt:            '0xfebc6f9f0149036006c4f5ac124685e0ef48e8a2',
};
```

## Wrap QELT → WQELT

```typescript
const WQELT_ABI = ['function deposit() payable', 'function withdraw(uint256)'];
const wqelt = new ethers.Contract(CONTRACTS.wqelt, WQELT_ABI, signer);

// Wrap 1 QELT
const tx = await wqelt.deposit({ value: ethers.parseEther('1') });
await tx.wait();
console.log('Wrapped 1 QELT → 1 WQELT');
```

## Unwrap WQELT → QELT

```typescript
// Unwrap 1 WQELT
const tx = await wqelt.withdraw(ethers.parseEther('1'));
await tx.wait();
console.log('Unwrapped 1 WQELT → 1 QELT');
```

## Query Pool State

```typescript
const POOL_MANAGER_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
];
const poolManager = new ethers.Contract(CONTRACTS.poolManager, POOL_MANAGER_ABI, provider);

// Compute pool ID from pool key
// poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['address','address','uint24','int24','address'],
  [currency0, currency1, 3000, 60, ethers.ZeroAddress]
));

const slot0 = await poolManager.getSlot0(poolId);
const liquidity = await poolManager.getLiquidity(poolId);

console.log('sqrtPriceX96:', slot0.sqrtPriceX96.toString());
console.log('tick:', slot0.tick);
console.log('lpFee:', slot0.lpFee, '(hundredths of bip)');
console.log('liquidity:', liquidity.toString());
```

## Add Liquidity (Mint Position)

```typescript
const ERC20_ABI = ['function approve(address,uint256) returns (bool)'];
const PERMIT2_ABI = ['function approve(address token, address spender, uint160 amount, uint48 deadline)'];

// 1. Approve Permit2
const token0 = new ethers.Contract(currency0, ERC20_ABI, signer);
await token0.approve(CONTRACTS.permit2, ethers.MaxUint256);

// 2. Approve PositionManager via Permit2
// Permit2's approve() takes uint160 amount — use uint160 max, NOT ethers.MaxUint256 (uint256).
// Passing MaxUint256 into a uint160 argument is out-of-range and causes the call to revert.
const MaxUint160 = (2n ** 160n) - 1n;
const permit2 = new ethers.Contract(CONTRACTS.permit2, PERMIT2_ABI, signer);
const deadline = Math.floor(Date.now() / 1000) + 3600;
await permit2.approve(currency0, CONTRACTS.positionManager, MaxUint160, deadline);

// 3. Mint position
const POSITION_MANAGER_ABI = [
  `function mint(
    (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey,
    int24 tickLower, int24 tickUpper, uint256 liquidity,
    uint256 amount0Max, uint256 amount1Max,
    uint256 amount0Min, uint256 amount1Min,
    address recipient, uint256 deadline
  ) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`
];
const positionManager = new ethers.Contract(CONTRACTS.positionManager, POSITION_MANAGER_ABI, signer);

const poolKey = { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };
const mintTx = await positionManager.mint(
  poolKey,
  -887220,   // tickLower
  887220,    // tickUpper
  liquidityAmount,
  amount0Max,
  amount1Max,
  amount0Min, // amount0 * 0.95 for 5% slippage
  amount1Min,
  await signer.getAddress(),
  Math.floor(Date.now() / 1000) + 1800
);
const receipt = await mintTx.wait();
```

## Get Position Info

```typescript
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 tokensOwed0, uint256 tokensOwed1)'
];
const positionManager = new ethers.Contract(CONTRACTS.positionManager, POSITION_MANAGER_ABI, provider);

const position = await positionManager.positions(tokenId);
console.log('Pool key:', position.poolKey);
console.log('Tick range:', position.tickLower, '→', position.tickUpper);
console.log('Liquidity:', position.liquidity.toString());
```

## Fee Tiers and Tick Spacings

| Fee (bps) | Fee (%) | Tick Spacing | Use Case |
|-----------|---------|-------------|---------|
| 100 | 0.01% | 1 | Stable pairs |
| 500 | 0.05% | 10 | Correlated assets |
| 3000 | 0.30% | 60 | Most pairs (default) |
| 10000 | 1.00% | 200 | Exotic/volatile pairs |

## Price Conversion

```typescript
// sqrtPriceX96 → price
// price = (sqrtPriceX96 / 2^96)^2
// Keep all arithmetic in bigint until final display to preserve precision.
// sqrtPriceX96 can be up to ~2^160, so squaring it overflows Number — use bigint throughout.
const sqrtPrice = BigInt(slot0.sqrtPriceX96);
const Q96 = 2n ** 96n;

// Fixed-point integer price scaled by 1e18 for display (adjust decimals as needed)
const PRECISION = 10n ** 18n;
const priceScaled = (sqrtPrice * sqrtPrice * PRECISION) / (Q96 * Q96);
// Convert to human-readable: divide by PRECISION accounting for token decimal difference
// e.g. for two 18-decimal tokens: price = Number(priceScaled) / 1e18
const priceFloat = Number(priceScaled) / 1e18;

// Alternative: use a decimal library (e.g. decimal.js) for full precision
// import Decimal from 'decimal.js';
// const price = new Decimal(sqrtPrice.toString()).pow(2).div(new Decimal(Q96.toString()).pow(2));
```
