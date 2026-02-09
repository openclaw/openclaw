# Pool Configuration

Configure Uniswap V4 liquidity pool settings for your Clanker token.

## Overview

Clanker tokens are deployed with Uniswap V4 liquidity pools. You can customize:
- **Paired token** - WETH, USDC, or other tokens
- **Initial market cap** - Starting price/liquidity
- **Pool positions** - Liquidity distribution
- **Fee structure** - Static or dynamic fees
- **Sniper protection** - Fee decay for early trades

## Default Pool Configuration

By default, tokens are paired with WETH using standard positions:

```typescript
const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  // Default pool: WETH pair with standard positions
});
```

## Paired Token Options

### WETH (Default)

```typescript
import { WETH_ADDRESSES } from 'clanker-sdk/constants';

pool: {
  pairedToken: WETH_ADDRESSES[base.id], // 0x4200000000000000000000000000000000000006
  positions: 'Standard',
}
```

### USDC

```typescript
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

pool: {
  pairedToken: USDC_BASE,
  positions: 'Standard',
}
```

## Pool Positions

Choose from preset position configurations:

```typescript
import { POOL_POSITIONS } from 'clanker-sdk/constants';

pool: {
  pairedToken: WETH_ADDRESSES[base.id],
  positions: POOL_POSITIONS.Standard, // Default distribution
  // or
  positions: POOL_POSITIONS.Project,  // Alternative distribution
}
```

## Custom Market Cap

Set a specific initial market cap:

```typescript
import { getTickFromMarketCap } from 'clanker-sdk';

// Get tick values for 5 ETH market cap
const customPool = getTickFromMarketCap(5);

pool: {
  ...customPool,
  positions: [
    {
      tickLower: customPool.tickIfToken0IsClanker,
      tickUpper: -120000,
      positionBps: 10_000, // 100% of liquidity in this position
    },
  ],
}
```

### Market Cap Examples

```typescript
// 5 ETH market cap
const pool5ETH = getTickFromMarketCap(5);

// 10 ETH market cap
const pool10ETH = getTickFromMarketCap(10);

// 20 ETH market cap
const pool20ETH = getTickFromMarketCap(20);
```

## Fee Configurations

Choose between static and dynamic fee structures:

```typescript
import { FEE_CONFIGS } from 'clanker-sdk/constants';

// Static basic fees
fees: FEE_CONFIGS.StaticBasic,

// Dynamic fees (tier 3)
fees: FEE_CONFIGS.Dynamic3,
```

**Note:** Monad chain only supports static fees (`FEE_CONFIGS.StaticBasic`).

## Sniper Protection

Configure fee decay to protect against snipers:

```typescript
sniperFees: {
  startingFee: 666_777,    // 66.6777% starting fee
  endingFee: 41_673,       // 4.1673% ending fee
  secondsToDecay: 15,      // 15 seconds to decay
}
```

### Contract Limits

From the Solidity contracts:

| Parameter | Limit | Notes |
|-----------|-------|-------|
| MAX_MEV_LP_FEE | 800,000 (80%) | Maximum starting fee |
| MAX_LP_FEE | 100,000 (10%) | Normal LP fee cap |
| MAX_MEV_MODULE_DELAY | 120 seconds | Maximum decay time |
| Fee Denominator | 1,000,000 | 100% = 1,000,000 |

**Important**: 
- `startingFee` cannot exceed 800,000 (80%)
- `secondsToDecay` cannot exceed 120 seconds (2 minutes)
- `startingFee` must be greater than `endingFee`

### How Sniper Fees Work

1. Trade immediately after deployment → Pay up to 80% fee
2. Fee decays parabolically over the decay period
3. After decay period → Normal LP fee applies

### Aggressive Sniper Protection

```typescript
sniperFees: {
  startingFee: 800_000,    // 80% starting fee (MAX)
  endingFee: 30_000,       // 3% ending fee
  secondsToDecay: 120,     // 2 minutes decay (MAX)
}
```

### Moderate Sniper Protection

```typescript
sniperFees: {
  startingFee: 666_777,    // ~66.7% starting fee
  endingFee: 41_673,       // ~4.2% ending fee
  secondsToDecay: 15,      // 15 seconds decay
}
```

### Minimal Sniper Protection

```typescript
sniperFees: {
  startingFee: 100_000,    // 10% starting fee
  endingFee: 30_000,       // 3% ending fee
  secondsToDecay: 5,       // 5 seconds decay
}
```

## Full Pool Configuration Example

```typescript
import { getTickFromMarketCap } from 'clanker-sdk';
import { FEE_CONFIGS, WETH_ADDRESSES } from 'clanker-sdk/constants';
import { base } from 'viem/chains';

const customPool = getTickFromMarketCap(10); // 10 ETH market cap

const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'Custom Pool Token',
  symbol: 'CPT',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  
  pool: {
    pairedToken: WETH_ADDRESSES[base.id],
    ...customPool,
    positions: [
      {
        tickLower: customPool.tickIfToken0IsClanker,
        tickUpper: -120000,
        positionBps: 10_000,
      },
    ],
  },
  
  fees: FEE_CONFIGS.StaticBasic,
  
  sniperFees: {
    startingFee: 666_777,
    endingFee: 41_673,
    secondsToDecay: 15,
  },
});
```

## Chain-Specific WETH Addresses

```typescript
import { WETH_ADDRESSES } from 'clanker-sdk/constants';

// Access WETH address by chain ID
const wethBase = WETH_ADDRESSES[8453];      // Base
const wethMainnet = WETH_ADDRESSES[1];      // Ethereum
const wethArbitrum = WETH_ADDRESSES[42161]; // Arbitrum
```

## LP Position Limits

From the Solidity contracts:

- **Maximum LP Positions**: 7
- **Position BPS Must Total**: 10,000 (100%)
- **Tick Bounds**: Must be within MIN_TICK and MAX_TICK
- **Tick Spacing**: Ticks must be multiples of the pool's tick spacing
- **Lower Tick Constraint**: tickLower must be >= tickIfToken0IsClanker

```typescript
pool: {
  positions: [
    { tickLower: -60000, tickUpper: -30000, positionBps: 5000 },  // 50%
    { tickLower: -30000, tickUpper: 0, positionBps: 3000 },       // 30%
    { tickLower: 0, tickUpper: 30000, positionBps: 2000 },        // 20%
  ],
}
```

## Best Practices

1. **Start with defaults** - Use standard positions unless you have specific needs
2. **Reasonable market cap** - Don't set unrealistically high initial valuations
3. **Enable sniper protection** - Protect early liquidity from bots
4. **Consider pair token** - WETH for most tokens, USDC for stables
5. **Test configurations** - Verify on testnet before mainnet
6. **Respect contract limits** - Max 7 LP positions, max 80% sniper fee, max 2 min decay
