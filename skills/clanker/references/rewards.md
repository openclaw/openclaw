# Rewards Configuration

Configure trading fee distribution for your Clanker token.

## Overview

Clanker tokens generate trading fees from the Uniswap V4 pool. You can configure how these fees are distributed among different recipients.

## Basic Rewards Configuration

```typescript
rewards: {
  recipients: [
    {
      recipient: account.address,    // Address receiving fees
      admin: account.address,        // Address that can update recipient
      bps: 5000,                     // 50% of fees (5000 basis points)
      token: 'Both',                 // Receive both tokens from pair
    },
    {
      recipient: '0x...other...',
      admin: '0x...other...',
      bps: 5000,                     // 50% of fees
      token: 'Both',
    },
  ],
}
```

## Basis Points (bps)

Fees are specified in basis points where:
- 100 bps = 1%
- 1000 bps = 10%
- 5000 bps = 50%
- 10000 bps = 100%

Total rewards must equal 10000 bps (100%).

## Contract Limits

From the Solidity contracts:

- **Maximum Reward Recipients**: 7
- **Total BPS Must Equal**: 10,000 (100%)
- **No Zero Addresses**: All admin and recipient addresses must be non-zero
- **No Zero Amounts**: Each recipient must have bps > 0

## Token Types

Choose which tokens each recipient receives from trading fees:

| Token Type | Description |
|------------|-------------|
| `'Clanker'` | Receive only the deployed token |
| `'Paired'` | Receive only the paired token (e.g., WETH) |
| `'Both'` | Receive both tokens |

```typescript
recipients: [
  {
    recipient: account.address,
    admin: account.address,
    bps: 10000,
    token: 'Paired',  // 'Clanker', 'Paired', or 'Both'
  },
]
```

**Recommendation**: Use `'Paired'` for simpler fee management since WETH is more liquid and easier to convert.

## Single Recipient

Receive all fees to one address:

```typescript
rewards: {
  recipients: [
    {
      recipient: account.address,
      admin: account.address,
      bps: 10000, // 100%
      token: 'Both',
    },
  ],
}
```

## Multiple Recipients

Split fees between creator and interface:

```typescript
rewards: {
  recipients: [
    {
      recipient: '0x...creator...',
      admin: '0x...creator...',
      bps: 7500, // 75% to creator
      token: 'Both',
    },
    {
      recipient: '0x...interface...',
      admin: '0x...interface...',
      bps: 2500, // 25% to interface
      token: 'Both',
    },
  ],
}
```

## Default Bankr Interface Fee

When deploying via Bankr, use this standard configuration with 20% interface fee:

```typescript
// Bankr interface fee recipient
const BANKR_INTERFACE_ADDRESS = '0xF60633D02690e2A15A54AB919925F3d038Df163e';

rewards: {
  recipients: [
    {
      recipient: account.address,           // Creator receives 80%
      admin: account.address,
      bps: 8000,
      token: 'Paired',                      // Receive paired token (WETH)
    },
    {
      recipient: BANKR_INTERFACE_ADDRESS,   // Bankr receives 20%
      admin: BANKR_INTERFACE_ADDRESS,
      bps: 2000,
      token: 'Paired',                      // Receive paired token (WETH)
    },
  ],
}
```

This is the **default and recommended configuration** for all token deployments via Bankr. Both recipients receive fees in the paired token (e.g., WETH) to simplify fee management.

## Check Available Rewards

Query unclaimed rewards for a recipient:

```typescript
const TOKEN_ADDRESS = '0x...';
const FEE_OWNER_ADDRESS = '0x...';

const availableFees = await clanker.availableRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});

console.log('Available fees:', availableFees);
```

## Claim Rewards

Claim accumulated trading fees:

```typescript
const TOKEN_ADDRESS = '0x...';
const FEE_OWNER_ADDRESS = '0x...';

const { txHash, error } = await clanker.claimRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});

if (error) {
  console.error('Claim failed:', error.message);
} else {
  console.log('Rewards claimed:', txHash);
}
```

## Update Reward Recipient

Change where rewards are sent (must be called by admin):

```typescript
const { txHash, error } = await clanker.updateRewardRecipient({
  token: TOKEN_ADDRESS,
  oldRecipient: '0x...old...',
  newRecipient: '0x...new...',
});
```

## Update Reward Admin

Transfer admin rights to a new address:

```typescript
const { txHash, error } = await clanker.updateRewardAdmin({
  token: TOKEN_ADDRESS,
  recipient: '0x...recipient...',
  newAdmin: '0x...newAdmin...',
});
```

## Read-Only Rewards Check

Check rewards without needing a wallet:

```typescript
import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { Clanker } from 'clanker-sdk/v4';

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
}) as PublicClient;

// Initialize without wallet (read-only)
const clanker = new Clanker({ publicClient });

const availableFees = await clanker.availableRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});
```

## Complete Rewards Example

```typescript
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { Clanker } from 'clanker-sdk/v4';

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({ chain: base, transport: http() }) as PublicClient;
const wallet = createWalletClient({ account, chain: base, transport: http() });

const clanker = new Clanker({ wallet, publicClient });

const TOKEN_ADDRESS = '0x1A84F1eD13C733e689AACffFb12e0999907357F0';
const FEE_OWNER_ADDRESS = '0x46e2c233a4C5CcBD6f48073F8808E0e4b3296477';

// Check available rewards
const availableFees = await clanker.availableRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: FEE_OWNER_ADDRESS,
});

console.log('Available fees:', availableFees);

// Claim if rewards available
if (availableFees.token0 > 0n || availableFees.token1 > 0n) {
  const { txHash, error } = await clanker.claimRewards({
    token: TOKEN_ADDRESS,
    rewardRecipient: FEE_OWNER_ADDRESS,
  });

  if (error) {
    console.error('Claim failed:', error.message);
  } else {
    console.log('Transaction hash:', txHash);
  }
}
```

## Best Practices

1. **Secure admin addresses** - Use multisig for high-value tokens
2. **Document fee split** - Be transparent with community about distribution
3. **Regular claims** - Don't let rewards accumulate excessively
4. **Test updates** - Verify recipient/admin changes on testnet first
5. **Fair distribution** - Consider community expectations for fee splits
