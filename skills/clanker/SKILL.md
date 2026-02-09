---
name: clanker
description: Deploy ERC20 tokens on Base, Ethereum, Arbitrum, and other EVM chains using the Clanker SDK. Use when the user wants to deploy a new token, create a memecoin, set up token vesting, configure airdrops, manage token rewards, claim LP fees, or update token metadata. Supports V4 deployment with vaults, airdrops, dev buys, custom market caps, vanity addresses, and multi-chain deployment.
metadata: {"openclaw":{"emoji":"🏭","homepage":"https://clanker.world"}}
---

# Clanker SDK

Deploy production-ready ERC20 tokens with built-in liquidity pools using the official Clanker TypeScript SDK.

## Overview

Clanker is a token deployment protocol that creates ERC20 tokens with Uniswap V4 liquidity pools in a single transaction. The SDK provides a TypeScript interface for deploying tokens with advanced features like vesting, airdrops, and customizable reward distribution.

## Quick Start

### Installation

```bash
npm install clanker-sdk viem
# or
yarn add clanker-sdk viem
# or
pnpm add clanker-sdk viem
```

### Environment Setup

Create a `.env` file with your private key:

```bash
PRIVATE_KEY=0x...your_private_key_here
```

### Basic Token Deployment

```typescript
import { Clanker } from 'clanker-sdk';
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
}) as PublicClient;

const wallet = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

const clanker = new Clanker({ wallet, publicClient });

const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  tokenAdmin: account.address,
  metadata: {
    description: 'My awesome token',
  },
  context: {
    interface: 'Clanker SDK',
  },
  vanity: true,
});

if (error) throw error;

const { address: tokenAddress } = await waitForTransaction();
console.log('Token deployed at:', tokenAddress);
```

## Core Capabilities

### 1. Token Deployment

Deploy tokens with full customization including metadata, social links, and pool configuration.

**Basic deployment:**
- Token name, symbol, and image (IPFS)
- Description and social media links
- Vanity address generation
- Custom pool configurations

**Reference:** [references/deployment.md](references/deployment.md)

### 2. Vault (Token Vesting)

Lock a percentage of tokens with lockup and vesting periods:

```typescript
vault: {
  percentage: 10,           // 10% of token supply
  lockupDuration: 2592000,  // 30 days cliff (in seconds)
  vestingDuration: 2592000, // 30 days linear vesting
  recipient: account.address,
}
```

**Reference:** [references/vesting.md](references/vesting.md)

### 3. Airdrops

Distribute tokens to multiple addresses using Merkle tree proofs:

```typescript
import { createAirdrop, registerAirdrop } from 'clanker-sdk/v4/extensions';

const { tree, airdrop } = createAirdrop([
  { account: '0x...', amount: 200_000_000 },
  { account: '0x...', amount: 50_000_000 },
]);

// Include in deployment
airdrop: {
  ...airdrop,
  lockupDuration: 86_400,  // 1 day
  vestingDuration: 86_400, // 1 day
}
```

**Reference:** [references/airdrops.md](references/airdrops.md)

### 4. Rewards Configuration

Configure trading fee distribution:

```typescript
rewards: {
  recipients: [
    {
      recipient: account.address,
      admin: account.address,
      bps: 5000,      // 50% of fees
      token: 'Both',  // Receive both tokens
    },
    {
      recipient: '0x...',
      admin: '0x...',
      bps: 5000,      // 50% of fees
      token: 'Both',
    },
  ],
}
```

#### Token Type Options

Choose which tokens each recipient receives from trading fees:

| Token Type | Description |
|------------|-------------|
| `'Clanker'` | Receive only the deployed token |
| `'Paired'` | Receive only the paired token (e.g., WETH) |
| `'Both'` | Receive both tokens |

#### Default Bankr Interface Fee

When deploying via Bankr, use this default rewards configuration with 20% interface fee:

```typescript
// Bankr interface fee recipient
const BANKR_INTERFACE_ADDRESS = '0xF60633D02690e2A15A54AB919925F3d038Df163e';

rewards: {
  recipients: [
    {
      recipient: account.address,           // Creator
      admin: account.address,
      bps: 8000,                            // 80% to creator
      token: 'Paired',                      // Receive paired token (WETH)
    },
    {
      recipient: BANKR_INTERFACE_ADDRESS,   // Bankr interface
      admin: BANKR_INTERFACE_ADDRESS,
      bps: 2000,                            // 20% to Bankr
      token: 'Paired',                      // Receive paired token (WETH)
    },
  ],
}
```

**Reference:** [references/rewards.md](references/rewards.md)

### 5. Dev Buy

Include an initial token purchase in the deployment:

```typescript
devBuy: {
  ethAmount: 0.1,           // Buy with 0.1 ETH
  recipient: account.address,
}
```

### 6. Custom Market Cap

Set initial token price/market cap:

```typescript
import { getTickFromMarketCap } from 'clanker-sdk';

const customPool = getTickFromMarketCap(5); // 5 ETH market cap

pool: {
  ...customPool,
  positions: [
    {
      tickLower: customPool.tickIfToken0IsClanker,
      tickUpper: -120000,
      positionBps: 10_000,
    },
  ],
}
```

**Reference:** [references/pool-config.md](references/pool-config.md)

### 7. Anti-Sniper Protection

Configure fee decay to protect against snipers:

```typescript
sniperFees: {
  startingFee: 666_777,    // 66.6777% starting fee
  endingFee: 41_673,       // 4.1673% ending fee
  secondsToDecay: 15,      // 15 seconds decay
}
```

## Contract Limits & Constants

| Parameter | Value | Notes |
|-----------|-------|-------|
| Token Supply | 100 billion | Fixed at 100,000,000,000 with 18 decimals |
| Max Extension BPS | 9000 (90%) | Max tokens to extensions, min 10% to LP |
| Max Extensions | 10 | Maximum number of extensions per deployment |
| Vault Min Lockup | 7 days | Minimum lockup duration for vesting |
| Airdrop Min Lockup | 1 day | Minimum lockup duration for airdrops |
| Max LP Fee | 10% | Normal trading fee cap |
| Max Sniper Fee | 80% | Maximum MEV/sniper protection fee |
| Sniper Fee Decay | 2 minutes max | Maximum time for sniper fee decay |
| Max Reward Recipients | 7 | Maximum fee distribution recipients |
| Max LP Positions | 7 | Maximum liquidity positions |

## Supported Chains

| Chain | Chain ID | Native Token | Status |
|-------|----------|--------------|--------|
| Base | 8453 | ETH | ✅ Full support |
| Ethereum | 1 | ETH | ✅ Full support |
| Arbitrum | 42161 | ETH | ✅ Full support |
| Unichain | - | ETH | ✅ Full support |
| Monad | - | MON | ✅ Static fees only |

## Post-Deployment Operations

### Claim Vaulted Tokens

```typescript
const claimable = await clanker.getVaultClaimableAmount({ token: TOKEN_ADDRESS });

if (claimable > 0n) {
  const { txHash } = await clanker.claimVaultedTokens({ token: TOKEN_ADDRESS });
}
```

### Collect Trading Rewards

```typescript
// Check available rewards
const availableFees = await clanker.availableRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});

// Claim rewards
const { txHash } = await clanker.claimRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});
```

### Update Token Metadata

```typescript
const metadata = JSON.stringify({
  description: 'Updated description',
  socialMediaUrls: [
    { platform: 'twitter', url: 'https://twitter.com/mytoken' },
    { platform: 'telegram', url: 'https://t.me/mytoken' },
  ],
});

const { txHash } = await clanker.updateMetadata({
  token: TOKEN_ADDRESS,
  metadata,
});
```

### Update Token Image

```typescript
const { txHash } = await clanker.updateImage({
  token: TOKEN_ADDRESS,
  image: 'ipfs://new_image_hash',
});
```

## Common Workflows

### Simple Memecoin Launch

1. Prepare token image (upload to IPFS)
2. Deploy with basic config (name, symbol, image)
3. Enable vanity address for memorable contract
4. Share contract address

### Community Token with Airdrop

1. Compile airdrop recipient list
2. Create Merkle tree with `createAirdrop()`
3. Deploy token with airdrop extension
4. Register airdrop with Clanker service
5. Share claim instructions

### Creator Token with Vesting

1. Deploy with vault configuration
2. Set lockup period (cliff)
3. Set vesting duration
4. Claim tokens as they vest

## Full Deployment Config

```typescript
// Bankr interface fee recipient (20%)
const BANKR_INTERFACE_ADDRESS = '0xF60633D02690e2A15A54AB919925F3d038Df163e';

const tokenConfig = {
  chainId: 8453,                    // Base
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  
  metadata: {
    description: 'Token description',
    socialMediaUrls: [
      { platform: 'twitter', url: '...' },
      { platform: 'telegram', url: '...' },
    ],
  },
  
  context: {
    interface: 'Bankr',
    platform: 'farcaster',
    messageId: '',
    id: '',
  },
  
  vault: {
    percentage: 10,
    lockupDuration: 2592000,
    vestingDuration: 2592000,
    recipient: account.address,
  },
  
  devBuy: {
    ethAmount: 0,
    recipient: account.address,
  },
  
  // Default: 80% creator, 20% Bankr interface (all in paired token)
  rewards: {
    recipients: [
      { 
        recipient: account.address,
        admin: account.address,
        bps: 8000,  // 80% to creator
        token: 'Paired',  // Receive paired token (WETH)
      },
      { 
        recipient: BANKR_INTERFACE_ADDRESS,
        admin: BANKR_INTERFACE_ADDRESS,
        bps: 2000,  // 20% to Bankr
        token: 'Paired',  // Receive paired token (WETH)
      },
    ],
  },
  
  pool: {
    pairedToken: '0x4200000000000000000000000000000000000006', // WETH
    positions: 'Standard',
  },
  
  fees: 'StaticBasic',
  vanity: true,
  
  sniperFees: {
    startingFee: 666_777,
    endingFee: 41_673,
    secondsToDecay: 15,
  },
};
```

## Best Practices

### Security

1. **Never expose private keys** - Use environment variables
2. **Test on testnet first** - Verify configs before mainnet
3. **Simulate transactions** - Use `*Simulate` methods before execution
4. **Verify addresses** - Double-check all recipient addresses

### Token Design

1. **Choose meaningful names** - Clear, memorable token identity
2. **Use quality images** - High-res, appropriate IPFS images
3. **Configure vesting wisely** - Align with project timeline

### Gas Optimization

1. **Use Base or Arbitrum** - Lower gas fees
2. **Batch operations** - Combine when possible
3. **Monitor gas prices** - Deploy during low-traffic periods

## Troubleshooting

### Common Issues

- **"Missing PRIVATE_KEY"** - Set environment variable
- **"Insufficient balance"** - Fund wallet with native token
- **"Transaction reverted"** - Check parameters, simulate first
- **"Invalid image"** - Ensure IPFS hash is accessible

### Debug Steps

1. Check wallet balance
2. Verify chain configuration
3. Use simulation methods
4. Check transaction on block explorer
5. Review error message details

## Resources

- **GitHub**: [github.com/clanker-devco/clanker-sdk](https://github.com/clanker-devco/clanker-sdk)
- **NPM**: [npmjs.com/package/clanker-sdk](https://www.npmjs.com/package/clanker-sdk)
- **Examples**: [github.com/clanker-devco/clanker-sdk/tree/main/examples/v4](https://github.com/clanker-devco/clanker-sdk/tree/main/examples/v4)

---

**💡 Pro Tip**: Always use the `vanity: true` option for memorable contract addresses.

**⚠️ Security**: Never commit private keys. Use `.env` files and add them to `.gitignore`.

**🚀 Quick Win**: Start with the simple deployment example, then add features like vesting and rewards as needed.
