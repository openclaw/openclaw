# Token Deployment

Complete guide to deploying tokens with the Clanker SDK.

## Simple Deployment

The minimal configuration for deploying a token:

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
  chainId: base.id,
  metadata: {
    description: 'My really cool token',
  },
  context: {
    interface: 'Clanker SDK',
  },
  vanity: true,
});

if (error) throw error;

console.log(`Deploying... ${base.blockExplorers.default.url}/tx/${txHash}`);
const { address: tokenAddress } = await waitForTransaction();
console.log(`Done! ${base.blockExplorers.default.url}/address/${tokenAddress}`);
```

## Multi-Chain Deployment

Deploy to different chains by changing the chain configuration:

```typescript
import { base, mainnet, arbitrum, unichain } from 'viem/chains';

// Chain-specific RPC URLs (optional, for better rate limits)
const RPC_URLS: Record<number, string | undefined> = {
  [mainnet.id]: process.env.RPC_URL_MAINNET,
  [base.id]: process.env.RPC_URL_BASE,
  [arbitrum.id]: process.env.RPC_URL_ARBITRUM,
  [unichain.id]: process.env.RPC_URL_UNICHAIN,
};

// Select chain
const CHAIN = base; // or mainnet, arbitrum, unichain

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URLS[CHAIN.id]),
}) as PublicClient;

const wallet = createWalletClient({
  account,
  chain: CHAIN,
  transport: http(RPC_URLS[CHAIN.id]),
});

const clanker = new Clanker({ wallet, publicClient });

// Deploy with chainId
const { txHash, waitForTransaction, error } = await clanker.deploy({
  chainId: CHAIN.id,
  name: 'My Token',
  symbol: 'TKN',
  // ... rest of config
});
```

## Token Metadata

Configure rich metadata for your token:

```typescript
metadata: {
  description: 'Token with custom configuration including vesting and rewards',
  socialMediaUrls: [
    { platform: 'twitter', url: 'https://twitter.com/mytoken' },
    { platform: 'telegram', url: 'https://t.me/mytoken' },
    { platform: 'discord', url: 'https://discord.gg/mytoken' },
  ],
  auditUrls: ['https://example.com/audit'],
}
```

## Context Configuration

Track deployment source and social platform info:

```typescript
context: {
  interface: 'Clanker SDK',     // Your app/interface name
  platform: 'farcaster',        // Social platform (farcaster, X, etc.)
  messageId: '',                // Cast hash, tweet URL, etc.
  id: '',                       // FID, X handle, etc.
}
```

## Vanity Addresses

Enable vanity address generation for memorable contract addresses:

```typescript
const { txHash, waitForTransaction, error } = await clanker.deploy({
  // ... other config
  vanity: true,  // SDK will mine for distinctive address
});
```

## Full Configuration Example

```typescript
// Bankr interface fee recipient (20%)
const BANKR_INTERFACE_ADDRESS = '0xF60633D02690e2A15A54AB919925F3d038Df163e';

const { txHash, waitForTransaction, error } = await clanker.deploy({
  chainId: base.id,
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  tokenAdmin: account.address,
  
  metadata: {
    description: 'Token with custom configuration including vesting and rewards',
    socialMediaUrls: [
      { platform: 'twitter', url: 'https://twitter.com/mytoken' },
      { platform: 'telegram', url: 'https://t.me/mytoken' },
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
  // Token options: 'Clanker' | 'Paired' | 'Both'
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
    pairedToken: '0x4200000000000000000000000000000000000006', // WETH on Base
    positions: 'Standard',
  },
  
  fees: 'StaticBasic',
  vanity: true,
  
  sniperFees: {
    startingFee: 666_777,
    endingFee: 41_673,
    secondsToDecay: 15,
  },
});
```

## Deploy with Custom Salt

Use a specific salt for deterministic address generation:

```typescript
import { zeroHash } from 'viem';

const { txHash, waitForTransaction, error } = await clanker.deploy({
  // ... config
  salt: zeroHash, // or custom bytes32 value
});
```

## Deploy with USDC Pair

Create a token paired with USDC instead of WETH:

```typescript
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const { txHash, waitForTransaction, error } = await clanker.deploy({
  // ... config
  pool: {
    pairedToken: USDC_BASE,
    positions: 'Standard',
  },
});
```

## Deploy with 20 ETH Initial Liquidity

Configure larger initial market cap:

```typescript
import { getTickFromMarketCap } from 'clanker-sdk';

const customPool = getTickFromMarketCap(20); // 20 ETH

const { txHash, waitForTransaction, error } = await clanker.deploy({
  // ... config
  pool: {
    ...customPool,
    positions: [
      {
        tickLower: customPool.tickIfToken0IsClanker,
        tickUpper: -120000,
        positionBps: 10_000,
      },
    ],
  },
});
```

## Error Handling

Always handle deployment errors:

```typescript
const { txHash, waitForTransaction, error } = await clanker.deploy(config);

if (error) {
  console.error('Deployment failed:', error.message);
  process.exit(1);
}

console.log(`Transaction: ${txHash}`);

const { address, error: txError } = await waitForTransaction();

if (txError) {
  console.error('Transaction failed:', txError.message);
  process.exit(1);
}

console.log('Token deployed at:', address);
```

## Simulation Before Deployment

Test deployment without executing:

```typescript
// Note: Check SDK docs for simulate method availability
try {
  await clanker.deploySimulate(config);
  console.log('Simulation successful');
} catch (error) {
  console.error('Simulation failed:', error);
}
```
