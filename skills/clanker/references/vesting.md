# Token Vesting (Vault)

Configure token vesting with lockup periods and linear vesting using the Clanker vault system.

## Overview

The vault system allows you to lock a percentage of the token supply with:
- **Lockup Duration**: Cliff period before any tokens can be claimed
- **Vesting Duration**: Linear vesting period after lockup
- **Recipient**: Address that receives vested tokens

## Basic Vault Configuration

```typescript
const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  
  vault: {
    percentage: 10,           // 10% of token supply
    lockupDuration: 2592000,  // 30 days cliff (in seconds)
    vestingDuration: 2592000, // 30 days linear vesting
    recipient: account.address,
  },
  
  // ... other config
});
```

## Duration Values

Common duration values in seconds:

| Duration | Seconds |
|----------|---------|
| 1 hour | 3600 |
| 1 day | 86400 |
| 7 days | 604800 |
| 14 days | 1209600 |
| 30 days | 2592000 |
| 60 days | 5184000 |
| 90 days | 7776000 |
| 180 days | 15552000 |
| 1 year | 31536000 |

## Contract Limits

From the Solidity contracts:

- **Minimum Lockup Duration**: 7 days (enforced on-chain)
- **Maximum Extension BPS**: 9000 (90% of supply can go to extensions total)
- **Minimum to LP**: 10% of supply must go to liquidity pool

```typescript
vault: {
  percentage: 10,           // Up to 90% combined with other extensions
  lockupDuration: 604800,   // Minimum 7 days (604800 seconds)
  vestingDuration: 2592000, // No minimum for vesting duration
}
```

**Note**: The vault is one of several possible extensions. The total of all extension percentages (vault + airdrop + etc.) cannot exceed 90%.

## Check Claimable Amount

After deployment, check how many tokens are available to claim:

```typescript
const TOKEN_ADDRESS = '0x...'; // Your deployed token

const claimable = await clanker.getVaultClaimableAmount({
  token: TOKEN_ADDRESS,
});

console.log('Claimable amount:', claimable.toString());
```

## Claim Vaulted Tokens

Claim tokens once the lockup period has passed:

```typescript
const TOKEN_ADDRESS = '0x...';

// Check if anything is claimable
const claimable = await clanker.getVaultClaimableAmount({
  token: TOKEN_ADDRESS,
});

if (claimable > 0n) {
  const { txHash, error } = await clanker.claimVaultedTokens({
    token: TOKEN_ADDRESS,
  });
  
  if (error) {
    console.error('Claim failed:', error.message);
  } else {
    console.log('Claim transaction:', txHash);
  }
} else {
  console.log('No tokens available to claim yet');
}
```

## Get Vault Claim Transaction

Get the transaction object for claiming (useful for batching or custom signing):

```typescript
const txObject = await clanker.getVaultClaimTransaction({
  token: TOKEN_ADDRESS,
});

console.log('Transaction object:', txObject);
// { to: '0x...', data: '0x...', value: 0n }
```

## Vesting Timeline Example

For a 10% vault with 30-day lockup and 30-day vesting:

```
Day 0:  Token deployed, 10% locked in vault
        ↓
Day 1-30: Lockup period (nothing claimable)
        ↓
Day 31: Vesting begins
        ~3.33% claimable (1/30 of vaulted amount)
        ↓
Day 45: ~50% of vaulted tokens claimable
        ↓
Day 60: 100% claimable
```

## Custom Recipient

Set a different address to receive vested tokens:

```typescript
vault: {
  percentage: 10,
  lockupDuration: 2592000,
  vestingDuration: 2592000,
  recipient: '0x...treasury_address...', // Different from tokenAdmin
}
```

If not specified, `recipient` defaults to `tokenAdmin`.

## Team Vesting Example

Configure vesting for a team allocation:

```typescript
const THIRTY_DAYS = 2592000;
const SIX_MONTHS = 15552000;

const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'Team Token',
  symbol: 'TEAM',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  
  vault: {
    percentage: 20,                  // 20% team allocation
    lockupDuration: SIX_MONTHS,      // 6-month cliff
    vestingDuration: SIX_MONTHS * 2, // 12-month vesting
    recipient: '0x...team_multisig...',
  },
  
  metadata: {
    description: 'Token with team vesting schedule',
  },
  
  context: {
    interface: 'Clanker SDK',
  },
});
```

## No Vesting

To deploy without any vesting, simply omit the `vault` configuration:

```typescript
const { txHash, waitForTransaction, error } = await clanker.deploy({
  name: 'My Token',
  symbol: 'TKN',
  image: 'ipfs://...',
  tokenAdmin: account.address,
  // No vault = no vesting
});
```

## Best Practices

1. **Reasonable lockup periods** - Align with project milestones
2. **Gradual vesting** - Avoid cliff-only (0 vesting duration)
3. **Transparent communication** - Share vesting schedule with community
4. **Secure recipient** - Use multisig for team vesting
5. **Test first** - Verify vesting math before mainnet
