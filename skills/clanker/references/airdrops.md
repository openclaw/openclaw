# Airdrops

Distribute tokens to multiple addresses using Merkle tree proofs with the Clanker airdrop extension.

## Overview

Airdrops allow you to allocate tokens to specific addresses during deployment. Key features:
- **Merkle tree verification** - Efficient on-chain proof verification
- **Lockup/vesting** - Control when tokens become claimable
- **Clanker service** - Optional proof storage and generation

## Create an Airdrop

```typescript
import { createAirdrop, registerAirdrop } from 'clanker-sdk/v4/extensions';

// Define recipients and amounts
const { tree, airdrop } = createAirdrop([
  {
    account: '0x308112D06027Cd838627b94dDFC16ea6B4D90004',
    amount: 200_000_000, // Amount in token units
  },
  {
    account: '0x1eaf444ebDf6495C57aD52A04C61521bBf564ace',
    amount: 50_000_000,
  },
  {
    account: '0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825',
    amount: 10_000_000,
  },
]);
```

## Deploy with Airdrop

Include the airdrop in your token deployment:

```typescript
import { Clanker } from 'clanker-sdk';
import { createAirdrop } from 'clanker-sdk/v4/extensions';

const { tree, airdrop } = createAirdrop([
  { account: '0x...', amount: 200_000_000 },
  { account: '0x...', amount: 50_000_000 },
]);

const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'Airdrop Token',
  symbol: 'DROP',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  
  metadata: {
    description: 'Token with an airdrop',
  },
  
  context: {
    interface: 'Clanker SDK',
  },
  
  airdrop: {
    ...airdrop,
    lockupDuration: 86_400,  // 1 day lockup
    vestingDuration: 86_400, // 1 day vesting
  },
  
  vanity: true,
});

if (error) throw error;

const { address } = await waitForTransaction();
console.log('Token deployed at:', address);
```

## Register Airdrop with Clanker Service

Store the Merkle tree with Clanker's service for easy proof generation:

```typescript
import { registerAirdrop, fetchAirdropProofs } from 'clanker-sdk/v4/extensions';
import { sleep } from 'bun'; // or setTimeout

// Wait for token to be indexed (minimum 10 seconds)
await sleep(10_000);

// Register the airdrop tree
await registerAirdrop(tokenAddress, tree);
console.log('Airdrop registered!');
```

## Fetch Airdrop Proofs

Get proofs for a specific address:

```typescript
import { fetchAirdropProofs } from 'clanker-sdk/v4/extensions';

const { proofs } = await fetchAirdropProofs(
  tokenAddress,
  '0x308112D06027Cd838627b94dDFC16ea6B4D90004'
);

console.log('Proofs:', proofs);
// [{ proof: [...], entry: { account: '0x...', amount: 200000000 } }]
```

## Claim Airdrop Tokens

Build and execute a claim transaction:

```typescript
import { getClaimAirdropTransaction } from 'clanker-sdk/v4/extensions';

const { proof, entry } = proofs[0];

const tx = getClaimAirdropTransaction({
  chainId: base.id,
  token: tokenAddress,
  recipient: entry.account,
  amount: entry.amount,
  proof,
});

// Execute the transaction
const hash = await wallet.sendTransaction(tx);
```

## Self-Managed Tree Storage

If you don't want to use the Clanker service, store and manage the tree yourself:

```typescript
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import fs from 'fs';

// After creating the airdrop
const { tree, airdrop } = createAirdrop([...]);

// Save the tree to a file
fs.writeFileSync('merkle-tree.json', JSON.stringify(tree.dump()));

// Later, load and use the tree
const loadedTree = StandardMerkleTree.load(
  JSON.parse(fs.readFileSync('merkle-tree.json', 'utf8'))
);
```

## Contract Limits

From the Solidity contracts:

- **Minimum Lockup Duration**: 1 day (86,400 seconds) - enforced on-chain
- **Maximum Extension BPS**: 9000 (90% of supply can go to extensions total)

```typescript
airdrop: {
  ...airdrop,
  lockupDuration: 86_400,  // Minimum 1 day required
  vestingDuration: 0,      // No minimum for vesting
}
```

**Note**: Unlike vault (7 days min), airdrop only requires 1 day minimum lockup.

## Airdrop with Extended Vesting

For gradual distribution:

```typescript
const THIRTY_DAYS = 2592000;

airdrop: {
  ...airdrop,
  lockupDuration: THIRTY_DAYS,      // 30-day cliff
  vestingDuration: THIRTY_DAYS * 3, // 90-day vesting
}
```

## Complete Airdrop Workflow

```typescript
import { sleep } from 'bun';
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  createAirdrop,
  fetchAirdropProofs,
  getClaimAirdropTransaction,
  registerAirdrop,
} from 'clanker-sdk/v4/extensions';
import { Clanker } from 'clanker-sdk/v4';

// Setup
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: base, transport: http() }) as PublicClient;
const wallet = createWalletClient({ account, chain: base, transport: http() });
const clanker = new Clanker({ publicClient, wallet });

// 1. Create the airdrop
const { tree, airdrop } = createAirdrop([
  { account: '0x308112D06027Cd838627b94dDFC16ea6B4D90004', amount: 200_000_000 },
  { account: '0x1eaf444ebDf6495C57aD52A04C61521bBf564ace', amount: 50_000_000 },
  { account: '0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825', amount: 10_000_000 },
]);

// 2. Deploy the token
const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'Airdrop Token',
  symbol: 'DROP',
  image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  tokenAdmin: account.address,
  metadata: { description: 'Token with an airdrop' },
  context: { interface: 'Clanker SDK' },
  airdrop: {
    ...airdrop,
    lockupDuration: 86_400,
    vestingDuration: 86_400,
  },
  vanity: true,
});

if (error) throw error;

const { address, error: txError } = await waitForTransaction();
if (txError) throw txError;

console.log(`Token deployed at: ${address}`);

// 3. Wait for indexing, then register
console.log('Waiting for indexing...');
await sleep(10_000);

await registerAirdrop(address, tree);
console.log('Airdrop registered!');

// 4. Fetch proofs for claiming
const { proofs } = await fetchAirdropProofs(
  address,
  '0x308112D06027Cd838627b94dDFC16ea6B4D90004'
);

console.log('Proofs ready for claiming:', proofs);
```

## Best Practices

1. **Verify recipient addresses** - Double-check all addresses before deployment
2. **Test with small amounts** - Verify the flow on testnet first
3. **Secure tree storage** - Back up the Merkle tree if self-managing
4. **Reasonable lockup** - Balance between anti-dump and user experience
5. **Communicate claim process** - Provide clear instructions to recipients
