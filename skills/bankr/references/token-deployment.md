# Token Deployment Reference

Deploy and manage tokens on EVM chains (via Clanker) and Solana (via Raydium LaunchLab).

## Supported Chains

| Chain | Protocol | Token Standard | Best For |
|-------|----------|----------------|----------|
| **Base** | Clanker | ERC20 | Memecoins, social tokens |
| **Unichain** | Clanker | ERC20 | Lower fees, newer ecosystem |
| **Solana** | Raydium LaunchLab | SPL | High-speed trading, bonding curves |

---

## Solana Token Launches (Raydium LaunchLab)

Launch SPL tokens on Solana with a bonding curve mechanism that auto-migrates to a Raydium CPMM pool.

### Deployment Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| **Name** | Yes | Token name (1-32 chars) | "MoonRocket" |
| **Symbol** | No | Ticker (1-10 chars), defaults to name | "MOON" |
| **Image** | No | Logo URL | "https://example.com/logo.png" |
| **Decimals** | No | Token decimals (0-9), default 6 | 6 |
| **Fee Recipient** | No | Wallet to receive 99.9% of creator fees | "7xKXtg..." |
| **Cliff Period** | No | Vesting cliff in seconds | 2592000 (30 days) |
| **Unlock Period** | No | Vesting period in seconds | 7776000 (90 days) |
| **Locked Amount** | No | Tokens to lock for vesting | 500000000 |

### Prompt Examples

**Launch tokens:**
- "Launch a token called MOON on Solana"
- "Deploy a Solana memecoin called DOGE2"
- "Launch SpaceRocket with symbol ROCK"
- "Create a token with 30 day cliff and 90 day vesting"
- "Launch BRAIN and route fees to 7xKXtg..."

**Check fees:**
- "How much fees can I claim for MOON?"
- "Check fee status for my token"

**Claim fees:**
- "Claim my fees for MOON" (works for both creator and fee recipient)
- "Claim creator fees for my token"

**Fee Key NFTs:**
- "Show my Fee Key NFTs"
- "What tokens do I have fee rights for?"
- "Transfer fees for MOON to 7xKXtg..."

**Claim shared fee NFT (post-migration):**
- "Claim my fee NFT for ROCKET"

### Bonding Curve Mechanics

1. **Launch**: Token starts with a bonding curve that determines price based on supply
2. **Trading**: Early buyers get lower prices; price increases as more tokens are bought
3. **Migration**: When bonding curve fills, token auto-migrates to Raydium CPMM pool
4. **Post-Migration**: Trading continues on standard AMM with LP fee distribution

**Benefits:**
- Fair launch mechanism (no pre-allocation needed)
- Price discovery through market demand
- Automatic liquidity provision
- No rug pull risk (liquidity is locked)

### Fee Structure

**During Bonding Curve Phase:**
| Fee | Recipient | Description |
|-----|-----------|-------------|
| 1% | Bankr Platform | Platform fee |
| 0.5% | Creator | Creator trading fee (or split with fee recipient) |

**Fee Sharing (when feeRecipient specified):**
| Share | Recipient | Description |
|-------|-----------|-------------|
| 99.9% | Fee Recipient | Main share of creator fees |
| 0.1% | Creator | Referrer fee |

**At Migration (when bonding curve completes):**
| LP Share | Recipient | Description |
|----------|-----------|-------------|
| 40% | Bankr Platform | Locked platform LP |
| 50% | Token Creator | Locked creator LP (Fee Key NFT) |
| 10% | Burned | Deflationary mechanism |

**Post-Migration:**
- Token trades on Raydium CPMM pool
- Fee Key NFT holders can claim 50% of LP trading fees

### Fee Claiming

**Checking Fee Status:**
- Use "How much fees can I claim for TOKEN?" to check status
- Shows pool status (bonding curve vs migrated)
- Explains how to claim based on your role

**Standard Tokens (No Fee Sharing):**
- Creator claims all 0.5% trading fees
- Use "Claim my fees for TOKEN"
- Requires ~0.005 SOL gas

**Tokens with Fee Sharing Arrangement:**
- BOTH creator AND fee recipient can initiate claims
- Fees automatically split: 99.9% to recipient, 0.1% to creator
- Gas is sponsored by Bankr (free for users)
- Use "Claim my fees for TOKEN" (works for either party)

**Post-Migration Fee Claiming:**
1. Fee recipient claims Fee Key NFT: "Claim my fee NFT for TOKEN"
2. Then claim ongoing LP fees: "Claim CPMM fees for TOKEN"

### Fee Key NFTs

Fee Key NFTs represent the right to claim LP trading fees after migration.

**How They Work:**
- Created when token migrates from bonding curve to CPMM
- Represent 50% share of LP trading fees
- Standard SPL token (decimals=0, amount=1)
- Transferable (with restrictions for permanent arrangements)

**Managing Fee Rights:**
- View your NFTs: "Show my Fee Key NFTs"
- Transfer to another wallet: "Transfer fees for TOKEN to ADDRESS"
- Claim if designated recipient: "Claim my fee NFT for TOKEN"

### Fee Recipient (Permanent Arrangements)

Specify a `feeRecipient` to route creator fees to a different wallet.

**How It Works:**
1. Launch token with `feeRecipient` address
2. During bonding curve: EITHER party can claim fees
3. Fees split automatically: 99.9% to recipient, 0.1% to creator
4. After migration: recipient claims Fee Key NFT
5. Recipient uses "Claim CPMM fees" for ongoing LP fees

**Important:**
- Creates a PERMANENT arrangement
- Deployer CANNOT transfer their Fee Key NFT
- Only the designated recipient can claim the NFT
- Use for treasuries, DAOs, collaborators, or charity

**Who Can Claim During Bonding Curve:**
- Token creator (deployer)
- Designated fee recipient
- Either party initiates, fees split automatically

### Vesting Parameters

Optional vesting for team tokens or investor allocations.

| Parameter | Description | Example |
|-----------|-------------|---------|
| Cliff Period | Time before any tokens unlock | 30 days = 2592000 seconds |
| Unlock Period | Time for gradual unlock after cliff | 90 days = 7776000 seconds |
| Locked Amount | Total tokens to lock | In token units with decimals |

### Gas Fees

| Operation | Cost | Sponsored? |
|-----------|------|------------|
| Token Launch | ~0.01-0.02 SOL | Yes (within limits) |
| Standard Fee Claim | ~0.005 SOL | No |
| Shared Fee Claim | ~0.005 SOL | Yes (always) |
| Transfer Fee Rights | ~0.005 SOL | No |
| Claim Fee NFT | ~0.005 SOL | No |

Gas is sponsored for token launches within daily limits (1/day standard, 10/day Bankr Club).
Shared fee claims are always sponsored to ensure atomic claim+transfer.

### Rate Limits

| User Type | Daily Limit | Gas Sponsored |
|-----------|-------------|---------------|
| Standard Users | Unlimited | 1 token/day |
| Bankr Club Members | Unlimited | 10 tokens/day |

Users can launch additional tokens beyond sponsored limits by paying ~0.01 SOL gas.

---

## EVM Token Launches (Clanker)

Deploy ERC20 tokens on Base and Unichain using Clanker.

### Deployment Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| **Name** | Yes | Full token name | "My Token" |
| **Symbol** | Yes | Ticker, 3-5 chars | "MTK" |
| **Description** | No | Token description | "A community token" |
| **Image** | No | Logo URL or upload | URL or file |
| **Website** | No | Project website | "myproject.com" |
| **Twitter** | No | Twitter/X handle | "@myproject" |
| **Telegram** | No | Telegram group | "@mytoken" |

### Prompt Examples

**Deploy tokens:**
- "Deploy a token called BankrFan with symbol BFAN"
- "Create a memecoin: name=DogeKiller, symbol=DOGEK"
- "Deploy token with website myproject.com and Twitter @myproject"
- "Create a token on Base"
- "Launch new token on Unichain"

**Claim fees:**
- "Claim fees for my token MTK"
- "Check my Clanker fees"
- "Claim legacy Clanker fees"

**Update metadata:**
- "Update description for MyToken"
- "Add Twitter link to my token"
- "Update logo for MyToken"

### Rate Limits

| User Type | Daily Limit |
|-----------|-------------|
| Standard Users | 1 token/day |
| Bankr Club Members | 10 tokens/day |

### Fee Structure

- Small fee on each trade, accumulated for token creator
- Claimable anytime via "Claim fees for my token"
- Legacy fees (older Clanker versions) claimed separately

### Chain Selection

**Base (Recommended):**
- Primary Clanker support
- Low deployment cost
- Growing ecosystem
- Easy liquidity provision

**Unichain:**
- Secondary option
- Low cost
- Newer ecosystem
- Less liquidity

### Deployment Process

1. **Specify Parameters**: Name, symbol (required); description, social links (optional)
2. **Contract Deployment**: Clanker deploys audited ERC20 contract with automatic liquidity
3. **Verification**: Get contract address, view on block explorer

---

## Common Issues

| Issue | Chain | Resolution |
|-------|-------|------------|
| Rate limit reached | Both | Wait 24 hours or upgrade to Bankr Club |
| Name/symbol taken | EVM | Choose different name |
| Insufficient SOL | Solana | Add SOL for gas fees |
| NFT not found | Solana | Token may still be on bonding curve |
| Cannot transfer NFT | Solana | Permanent fee arrangement exists |
| No fees to claim | Solana | No trades yet or recently claimed |
| Token migrated | Solana | Use CPMM fee claiming instead |

## Best Practices

### Before Deploying
1. **Choose unique name/symbol** — Check availability
2. **Prepare branding** — Logo, description ready
3. **Choose right chain** — Solana for bonding curves, Base for ERC20
4. **Understand fees** — Know the fee structure for your chain

### During Deployment
1. **Solana**: Only tokenName is required — don't over-specify
2. **EVM**: Add metadata and social links immediately
3. **Save addresses** — Token address and any NFT mints

### After Deployment
1. **Check fee status** — "How much fees can I claim for TOKEN?"
2. **Claim fees regularly** — Don't leave money unclaimed
3. **Monitor migration** (Solana) — Fee Key NFT created at migration
4. **Engage community** — Marketing and updates

## Security Considerations

### Solana (LaunchLab)
- Bonding curve prevents rug pulls (liquidity locked)
- LP is automatically locked at migration
- Fee Key NFTs are standard SPL tokens
- Permanent fee arrangements are immutable
- Shared fee claims use atomic transactions (claim+transfer)

### EVM (Clanker)
- Uses audited contracts
- Standard ERC20 implementation
- Verifiable on block explorer
- Creator controls metadata

## Legal Considerations

**Disclaimer:**
- Token deployment may have legal implications
- Consider securities laws in your jurisdiction
- Consult legal counsel for serious projects
- Be transparent with community
- Don't make price promises

---

**Solana Tip**: Just say "Launch TOKEN_NAME" — only the name is required. Symbol defaults to name, and the bonding curve handles everything else.

**Fee Claiming Tip**: Both creator and fee recipient can claim fees during bonding curve. Just say "Claim my fees for TOKEN" — the system handles the split automatically.

**EVM Tip**: Add social links during deployment for better discoverability on aggregators.
