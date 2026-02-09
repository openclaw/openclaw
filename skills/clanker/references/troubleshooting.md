# Troubleshooting

Common issues and solutions when using the Clanker SDK.

## Setup Issues

### "Missing PRIVATE_KEY env var"

**Cause:** Environment variable not set or not in correct format.

**Solution:**
```bash
# Ensure PRIVATE_KEY is set with 0x prefix
export PRIVATE_KEY=0x...your_64_character_hex_key...

# Or in .env file
PRIVATE_KEY=0x...your_64_character_hex_key...
```

### "Invalid private key format"

**Cause:** Private key missing `0x` prefix or incorrect length.

**Solution:**
```typescript
// Validate private key format
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY || !isHex(PRIVATE_KEY)) {
  throw new Error('PRIVATE_KEY must be a hex string starting with 0x');
}
```

### TypeScript Import Errors

**Cause:** Incorrect import paths or missing viem peer dependency.

**Solution:**
```bash
# Ensure both packages installed
npm install clanker-sdk viem
```

```typescript
// Correct imports
import { Clanker } from 'clanker-sdk';
import { Clanker } from 'clanker-sdk/v4'; // V4 specific
import { createAirdrop } from 'clanker-sdk/v4/extensions';
```

## Deployment Issues

### "Insufficient balance"

**Cause:** Wallet doesn't have enough native token for gas.

**Solution:**
```typescript
// Check balance before deployment
const balance = await publicClient.getBalance({ address: account.address });
console.log('Balance:', formatEther(balance), 'ETH');

// Fund wallet if needed
// Minimum ~0.01 ETH recommended for Base, more for Ethereum mainnet
```

### "Transaction reverted"

**Cause:** Invalid configuration or contract state issue.

**Solution:**
1. Simulate first:
```typescript
try {
  await clanker.deploySimulate(config);
  console.log('Simulation passed');
} catch (error) {
  console.error('Would revert:', error);
}
```

2. Check configuration values:
```typescript
// Ensure required fields
if (!config.name || !config.symbol) {
  throw new Error('Name and symbol required');
}

// Validate vault percentage
if (config.vault?.percentage > 30) {
  throw new Error('Vault percentage max is 30%');
}

// Validate rewards total
const totalBps = config.rewards?.recipients?.reduce(
  (sum, r) => sum + r.bps, 0
) || 0;
if (totalBps !== 10000) {
  throw new Error('Rewards must total 10000 bps');
}
```

### "Invalid image"

**Cause:** IPFS hash not accessible or invalid format.

**Solution:**
```typescript
// Ensure valid IPFS URI format
const image = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

// Test accessibility
// Visit: https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

### "Transaction pending too long"

**Cause:** Gas price too low or network congestion.

**Solution:**
```typescript
// Wait with timeout
const { address, error } = await Promise.race([
  waitForTransaction(),
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), 120000)
  ),
]);

// Check transaction status manually
const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
```

## Chain-Specific Issues

### Monad: "Dynamic fees not supported"

**Cause:** Monad only supports static fee configurations.

**Solution:**
```typescript
import { FEE_CONFIGS } from 'clanker-sdk/constants';

// Use static fees for Monad
fees: FEE_CONFIGS.StaticBasic, // NOT Dynamic3
```

### Wrong Chain

**Cause:** Wallet and publicClient configured for different chains.

**Solution:**
```typescript
// Ensure consistent chain configuration
const CHAIN = base;

const publicClient = createPublicClient({
  chain: CHAIN, // Same chain
  transport: http(),
});

const wallet = createWalletClient({
  account,
  chain: CHAIN, // Same chain
  transport: http(),
});

const { txHash } = await clanker.deploy({
  chainId: CHAIN.id, // Same chain ID
  // ...
});
```

## Post-Deployment Issues

### "No vault tokens to claim"

**Cause:** Lockup period hasn't passed yet.

**Solution:**
```typescript
// Check current claimable amount
const claimable = await clanker.getVaultClaimableAmount({ token: TOKEN_ADDRESS });
console.log('Claimable:', claimable.toString());

// If 0, lockup hasn't passed
// Check deployment block time + lockupDuration
```

### "Cannot claim rewards"

**Cause:** Not the reward recipient or no rewards accumulated.

**Solution:**
```typescript
// Check available rewards first
const available = await clanker.availableRewards({
  token: TOKEN_ADDRESS,
  rewardRecipient: YOUR_ADDRESS,
});

console.log('Available:', available);

// Ensure you're the correct recipient
```

### "Cannot update metadata"

**Cause:** Not the token admin.

**Solution:**
```typescript
// Only tokenAdmin can update metadata
// Verify you're using the same account that deployed
console.log('Your address:', account.address);
// Compare with tokenAdmin set during deployment
```

## Airdrop Issues

### "Airdrop not registered"

**Cause:** Didn't wait for indexing before registering.

**Solution:**
```typescript
// Wait at least 10 seconds after deployment
await sleep(10_000);
await registerAirdrop(tokenAddress, tree);
```

### "Invalid proof"

**Cause:** Merkle tree mismatch or wrong address.

**Solution:**
```typescript
// Regenerate the tree with same data
const { tree, airdrop } = createAirdrop(originalRecipients);

// Ensure exact address match (case-sensitive)
const proof = getAllowlistMerkleProof(tree, entries, address.toLowerCase(), amount);
```

## RPC Issues

### "Rate limited"

**Cause:** Public RPC rate limits exceeded.

**Solution:**
```typescript
// Use dedicated RPC URL
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.RPC_URL_BASE), // Alchemy, Infura, etc.
});
```

### "Request failed"

**Cause:** Network issues or RPC unavailable.

**Solution:**
```typescript
// Add retry logic
async function deployWithRetry(config, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await clanker.deploy(config);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(1000 * (i + 1)); // Exponential backoff
    }
  }
}
```

## Contract Error Reference

Common revert reasons from the Solidity contracts:

| Error | Cause | Solution |
|-------|-------|----------|
| `VaultLockupDurationTooShort` | Lockup < 7 days | Set lockupDuration ≥ 604800 |
| `AirdropLockupDurationTooShort` | Lockup < 1 day | Set lockupDuration ≥ 86400 |
| `MaxExtensionBpsExceeded` | Extensions > 90% | Reduce total extension percentage |
| `MaxExtensionsExceeded` | More than 10 extensions | Use fewer extensions |
| `TooManyRewardParticipants` | More than 7 recipients | Reduce reward recipients |
| `TooManyPositions` | More than 7 LP positions | Use fewer positions |
| `InvalidRewardBps` | Rewards ≠ 10000 bps | Ensure rewards total exactly 10000 |
| `StartingFeeGreaterThanMaxLpFee` | Sniper fee > 80% | Set startingFee ≤ 800000 |
| `TimeDecayLongerThanMaxMevDelay` | Decay > 2 min | Set secondsToDecay ≤ 120 |
| `StartingFeeMustBeGreaterThanEndingFee` | startingFee ≤ endingFee | Increase starting or decrease ending fee |

## Debug Checklist

1. ✅ Private key set and valid (starts with 0x)
2. ✅ Wallet funded with native token
3. ✅ Chain configuration consistent
4. ✅ IPFS image accessible
5. ✅ Required fields provided (name, symbol, image, tokenAdmin)
6. ✅ Total extension BPS ≤ 9000 (90%)
7. ✅ Vault lockup ≥ 7 days (604800 seconds)
8. ✅ Airdrop lockup ≥ 1 day (86400 seconds)
9. ✅ Rewards total = 10000 bps exactly
10. ✅ Reward recipients ≤ 7
11. ✅ LP positions ≤ 7
12. ✅ Sniper startingFee ≤ 800000 (80%)
13. ✅ Sniper secondsToDecay ≤ 120 (2 minutes)
14. ✅ Static fees for Monad chain
15. ✅ Waited for indexing before airdrop registration
16. ✅ Using correct recipient address for claims

## Getting Help

1. **Check SDK examples**: [github.com/clanker-devco/clanker-sdk/tree/main/examples](https://github.com/clanker-devco/clanker-sdk/tree/main/examples)
2. **Review error messages**: Usually contain specific guidance
3. **Verify on block explorer**: Check transaction status and logs
4. **Test on testnet**: Validate configuration before mainnet
