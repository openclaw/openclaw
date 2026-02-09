# AGENTS.md - Ethereum Wingman

This file provides comprehensive guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working on Ethereum smart contract development.

**Version**: 2.0.0  
**Author**: BuidlGuidl  
**Last Updated**: January 2026

---

## AI AGENT INSTRUCTIONS - READ THIS FIRST

### Default Stack: Scaffold-ETH 2 with Fork Mode

When a user wants to BUILD any Ethereum project, follow these steps:

**Step 1: Create Project**

```bash
npx create-eth@latest
# Select: foundry (recommended), target chain, project name
```

**Step 2: Fix Polling Interval**

Edit `packages/nextjs/scaffold.config.ts` and change:
```typescript
pollingInterval: 30000,  // Default: 30 seconds (way too slow!)
```
to:
```typescript
pollingInterval: 3000,   // 3 seconds (much better for development)
```

**Step 3: Install & Fork a Live Network**

```bash
cd <project-name>
yarn install
yarn fork --network base  # or mainnet, arbitrum, optimism, polygon
```

**Step 4: Enable Auto Block Mining (REQUIRED!)**

```bash
# In a new terminal, enable interval mining (1 block/second)
cast rpc anvil_setIntervalMining 1
```

Without this, `block.timestamp` stays FROZEN at the fork point and time-dependent logic breaks (deadlines, vesting, staking periods, oracle staleness checks).

**Optional: Make it permanent** by editing `packages/foundry/package.json` to add `--block-time 1` to the fork script.

**Step 5: Deploy to Local Fork (FREE!)**

```bash
yarn deploy
```

**Step 6: Start Frontend**

```bash
yarn start
```

**Step 7: Test the Frontend**

After the frontend is running, open a browser and test the app as the burner wallet user:

1. **Navigate** to `http://localhost:3000`
2. **Take a snapshot** to get page elements (the burner wallet address is in the header)
3. **Click the faucet** to fund the burner wallet with ETH
4. **Transfer tokens** from whales if needed (use burner address from page)
5. **Click through the app** to verify functionality

Use the `cursor-browser-extension` MCP tools:
- `browser_navigate` - Open the app URL
- `browser_snapshot` - Get element refs for clicking
- `browser_click` - Click buttons (faucet, buy, stake, etc.)
- `browser_type` - Enter values into input fields
- `browser_wait_for` - Wait for transaction confirmation

See `tools/testing/frontend-testing.md` for detailed workflows.

**Speed Note**: This is a fullstack app - browser testing is the primary test method. On a local fork, transactions confirm instantly. With `pollingInterval: 3000`, the UI updates within 3 seconds. Don't wait 20-30 seconds between clicks - each action takes just a few seconds total.

### DO NOT:

- Run `yarn chain` (use `yarn fork --network <chain>` instead - gives you real protocol state!)
- Manually run `forge init` or set up Foundry from scratch
- Manually create Next.js projects  
- Set up wallet connection manually (SE2 has RainbowKit pre-configured)
- Create custom deploy scripts (use SE2's deploy system)

### Why Fork Mode?

```
yarn chain (WRONG)              yarn fork --network base (CORRECT)
└─ Empty local chain            └─ Fork of real Base mainnet
└─ No protocols                 └─ Uniswap, Aave, etc. all available
└─ No tokens                    └─ Real USDC, WETH balances exist
└─ Testing in isolation         └─ Test against REAL protocol state
└─ Can't integrate DeFi         └─ Full DeFi composability
```

### Auto Block Mining (Covered in Step 4)

Step 4 above is REQUIRED. Without interval mining, `block.timestamp` stays frozen at the fork point.

Alternative: Start Anvil directly with `--block-time` flag:
```bash
anvil --fork-url $RPC_URL --block-time 1
```

### Address Data Available

Token, protocol, and whale addresses are in `data/addresses/`:
- `tokens.json` - WETH, USDC, DAI, etc. per chain
- `protocols.json` - Uniswap, Aave, Chainlink, etc. per chain
- `whales.json` - Addresses with large token balances for testing

### Funding Test Wallets on Fork

```bash
# Give whale ETH for gas
cast rpc anvil_setBalance 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb 0x56BC75E2D63100000

# Impersonate Morpho Blue (USDC whale on Base)
cast rpc anvil_impersonateAccount 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb

# Transfer 10,000 USDC (6 decimals)
cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "transfer(address,uint256)" YOUR_ADDRESS 10000000000 \
  --from 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb --unlocked
```

---

## 🚨 FRONTEND UX RULES (MANDATORY)

These are hard rules. A build is NOT done until all are satisfied.

### Rule 1: Every Onchain Button — Loader + Disable
ANY button triggering a blockchain tx MUST disable on click and show a loader. **Each button gets its own loading state** — NEVER share a single `isLoading` across multiple buttons (causes wrong text on wrong button when UI switches).

```typescript
const [isApproving, setIsApproving] = useState(false);
<button disabled={isApproving} onClick={async () => {
  setIsApproving(true);
  try { await writeContractAsync({ functionName: "approve", args: [...] }); }
  catch (e) { notification.error("Failed"); }
  finally { setIsApproving(false); }
}}>
  {isApproving ? "Approving..." : "Approve"}
</button>
```

### Rule 2: Three-Button Flow — Network → Approve → Action
For approve-then-action patterns, show exactly ONE button: wrong network → "Switch to Base" | not enough approved → "Approve" | approved → "Stake/Deposit". Always read allowance via a hook (auto-updates). Network check comes FIRST — approve on wrong network breaks everything.

### Rule 3: Address Display — Always `<Address/>`
Every Ethereum address must use scaffold-eth's `<Address/>` component. Never render raw hex.

### Rule 4: RPC — Never Public RPCs
Always configure `rpcOverrides` in `scaffold.config.ts` with reliable RPCs (Alchemy, Infura, etc.). Public RPCs (`mainnet.base.org`) rate-limit. Monitor polling: ~1 req/3sec is correct, 15+/sec means a bug.

### Rule 5: Pre-Publish Checklist
Before deploying to production: OG/Twitter meta with **absolute live URL** for images (not localhost/relative/env var), correct page title, updated favicon, footer link to your repo, README updated, no hardcoded localhost/testnet values.

See `tools/testing/frontend-qa-checklist.md` for full browser test protocols.

---

## 🔄 THREE-PHASE BUILD PROCESS

Bugs should be caught in the cheapest phase. Don't jump to production.

**Phase 1: Localhost + Local Chain + Burner Wallet** — Free, instant. Test logic, rendering, flows. Exit: all pages render, all buttons work, forge test passes, no console errors.

**Phase 2: Localhost + Live L2 + MetaMask** — Real gas, 2-3sec tx times. Test wallet UX: loaders, double-click prevention, approve flow, network switching, RPC stability. Exit: every button has its own loader, approve flow works, reject recovers gracefully.

**Phase 3: Live Frontend + Live Chain** — Highest cost, slowest loop. Test unfurls, no localhost artifacts, production env. Exit: OG unfurl works, all Phase 2 criteria pass on live URL.

**Golden rule:** Every bug found in Phase 3 means Phase 1 or 2 testing failed.

See `tools/testing/frontend-qa-checklist.md` for detailed exit criteria and browser test protocols per phase.

---

## THE MOST CRITICAL CONCEPT IN ETHEREUM DEVELOPMENT

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│ SMART CONTRACTS CANNOT EXECUTE THEMSELVES.                      │
│                                                                 │
│ There is no cron job. No scheduler. No background process.      │
│ Nothing happens unless an EOA sends a transaction.              │
│                                                                 │
│ Your job as a builder:                                          │
│ 1. Expose functions that ANYONE can call                        │
│ 2. Design INCENTIVES so someone WANTS to call them              │
│ 3. Make it PROFITABLE to keep your protocol running             │
│                                                                 │
│ If no one has a reason to call your function, it won't run.     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### The Question You Must Always Ask

**"WHO CALLS THIS FUNCTION? WHY WOULD THEY PAY GAS?"**

### Incentive Design Patterns

**Pattern 1: Natural User Interest**

```solidity
// Users WANT to claim their rewards
function claimRewards() external {
    uint256 reward = pendingRewards[msg.sender];
    require(reward > 0, "No rewards");
    pendingRewards[msg.sender] = 0;
    rewardToken.transfer(msg.sender, reward);
}
// Will be called: Yes, users want their money
```

**Pattern 2: Caller Rewards (Keeper Incentives)**

```solidity
// LIQUIDATION: Caller gets bonus for liquidating unhealthy positions
function liquidate(address user) external {
    require(getHealthFactor(user) < 1e18, "Position healthy");
    uint256 debt = userDebt[user];
    uint256 collateral = userCollateral[user];
    
    debtToken.transferFrom(msg.sender, address(this), debt);
    
    // Liquidator gets collateral + 5% BONUS
    uint256 bonus = (collateral * 500) / 10000;
    collateralToken.transfer(msg.sender, collateral + bonus);
    
    userDebt[user] = 0;
    userCollateral[user] = 0;
}
// Incentive: Liquidator profits from the bonus
```

**Pattern 3: Yield Harvesting**

```solidity
// Caller gets a cut for triggering harvest
function harvest() external {
    uint256 yield = externalProtocol.claimRewards();
    uint256 callerReward = yield / 100; // 1%
    rewardToken.transfer(msg.sender, callerReward);
    rewardToken.transfer(address(vault), yield - callerReward);
}
// Incentive: Caller gets 1% of harvested yield
```

### Anti-Patterns to Avoid

```solidity
// BAD: This will NEVER run automatically!
function dailyDistribution() external {
    require(block.timestamp >= lastDistribution + 1 days);
    // This sits here forever if no one calls it
}

// BAD: Why would anyone pay gas?
function updateGlobalState() external {
    globalCounter++;
    // Nobody will call this. Gas costs money.
}

// BAD: Single point of failure
function processExpiredPositions() external onlyOwner {
    // What if admin goes offline? Protocol stops working!
}
```

---

## Critical Gotchas (12 Must-Know Rules)

### 1. Token Decimals Vary

**USDC = 6 decimals, not 18!**

```solidity
// BAD: Assumes 18 decimals - transfers 1 TRILLION USDC!
uint256 oneToken = 1e18;
token.transfer(user, oneToken);

// GOOD: Check decimals
uint256 oneToken = 10 ** token.decimals();
token.transfer(user, oneToken);
```

| Token | Decimals | 1 Token = |
|-------|----------|-----------|
| USDC, USDT | 6 | 1,000,000 |
| WBTC | 8 | 100,000,000 |
| DAI, WETH, most | 18 | 1e18 |

### 2. ETH is Measured in Wei

1 ETH = 10^18 wei

```solidity
// BAD: Sends 1 wei (almost nothing)
payable(user).transfer(1);

// GOOD: Use ether keyword
payable(user).transfer(1 ether);
payable(user).transfer(0.1 ether);
```

### 3. ERC-20 Approve Pattern Required

Contracts cannot pull tokens without approval!

```solidity
// Two-step process:
// 1. User calls: token.approve(spender, amount)
// 2. Spender calls: token.transferFrom(user, recipient, amount)

// DANGEROUS: Allows draining all tokens
token.approve(spender, type(uint256).max);

// SAFE: Approve exact amount
token.approve(spender, exactAmount);
```

### 4. Solidity Has No Floating Point

Use basis points (1 bp = 0.01%):

```solidity
// BAD: This equals 0, not 0.05
uint256 fivePercent = 5 / 100;

// GOOD: Basis points
uint256 FEE_BPS = 500; // 5% = 500 basis points
uint256 fee = (amount * FEE_BPS) / 10000;

// GOOD: Multiply before divide
uint256 fee = (amount * 5) / 100;
```

### 5. Reentrancy Attacks

External calls can call back into your contract:

```solidity
// VULNERABLE
function withdraw() external {
    uint256 bal = balances[msg.sender];
    (bool success,) = msg.sender.call{value: bal}("");
    balances[msg.sender] = 0; // Too late! Already re-entered
}

// SAFE: Checks-Effects-Interactions pattern
function withdraw() external nonReentrant {
    uint256 bal = balances[msg.sender];
    balances[msg.sender] = 0; // Effect BEFORE interaction
    (bool success,) = msg.sender.call{value: bal}("");
    require(success);
}
```

Always use OpenZeppelin's ReentrancyGuard.

### 6. Never Use DEX Spot Prices as Oracles

Flash loans can manipulate spot prices instantly:

```solidity
// VULNERABLE: Flash loan attack
function getPrice() internal view returns (uint256) {
    return dex.getSpotPrice();
}

// SAFE: Use Chainlink
function getPrice() internal view returns (uint256) {
    (, int256 price,, uint256 updatedAt,) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale");
    require(price > 0, "Invalid");
    return uint256(price);
}
```

### 7. Vault Inflation Attack (First Depositor)

First depositor can manipulate share price to steal from later depositors:

```solidity
// ATTACK:
// 1. Deposit 1 wei -> get 1 share
// 2. Donate 10000 tokens directly
// 3. Share price = 10001 / 1 = 10001 per share
// 4. Victim deposits 9999 -> gets 0 shares
// 5. Attacker redeems 1 share -> gets all 20000 tokens

// Mitigation: Virtual offset
function convertToShares(uint256 assets) public view returns (uint256) {
    return assets.mulDiv(totalSupply() + 1e3, totalAssets() + 1);
}
```

### 8. Access Control Missing

Anyone can call unprotected functions:

```solidity
// VULNERABLE: Anyone can withdraw
function withdrawAll() external {
    payable(msg.sender).transfer(address(this).balance);
}

// SAFE: Owner only
function withdrawAll() external onlyOwner {
    payable(owner).transfer(address(this).balance);
}
```

### 9. Integer Overflow (Pre-0.8)

Solidity 0.8+ has built-in checks, but watch for `unchecked` blocks:

```solidity
// 0.8+ DANGEROUS if using unchecked
unchecked {
    uint8 x = 255;
    x += 1; // x = 0 (overflow!)
}
```

### 10. Unchecked Return Values

Some tokens (USDT) don't return bool on transfer:

```solidity
// VULNERABLE: USDT doesn't return bool
bool success = token.transfer(to, amount);

// SAFE: Use SafeERC20
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
using SafeERC20 for IERC20;

token.safeTransfer(to, amount);
```

### 11. Timestamp Dependence

Miners can manipulate timestamps by ~15 seconds:

```solidity
// VULNERABLE for precise timing
require(block.timestamp == exactTime);

// OK for approximate timing (hours/days)
require(block.timestamp >= deadline);
```

### 12. tx.origin Authentication

Never use for access control:

```solidity
// VULNERABLE: Phishing attack
require(tx.origin == owner);

// SAFE: Use msg.sender
require(msg.sender == owner);
```

---

## Historical Hacks: Lessons Learned

### The DAO Hack (2016) - $50M
**Vulnerability**: Reentrancy attack
**Lesson**: Always update state BEFORE external calls

### bZx Flash Loan (2020) - ~$1M
**Vulnerability**: DEX spot price as oracle
**Lesson**: NEVER use spot DEX prices for anything valuable

### Nomad Bridge (2022) - $190M
**Vulnerability**: Zero root accepted as valid
**Lesson**: Always validate against zero values explicitly

### Wormhole (2022) - $326M
**Vulnerability**: Deprecated function with incomplete verification
**Lesson**: Remove deprecated code completely

---

## Scaffold-ETH 2 Development

### Project Structure

```
packages/
├── foundry/              # Smart contracts (recommended)
│   ├── contracts/        # Your Solidity files
│   ├── script/           # Deploy scripts
│   └── test/             # Forge tests
└── nextjs/
    ├── app/              # React pages
    ├── components/       # UI components
    └── contracts/        # Generated ABIs + externalContracts.ts
```

### Essential Hooks

```typescript
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

// Read contract data
const { data: greeting } = useScaffoldReadContract({
  contractName: "YourContract",
  functionName: "greeting",
});

// Write to contract
const { writeContractAsync } = useScaffoldWriteContract("YourContract");
await writeContractAsync({
  functionName: "setGreeting",
  args: ["Hello!"],
});

// Watch events
useScaffoldEventHistory({
  contractName: "YourContract",
  eventName: "GreetingChange",
  fromBlock: 0n,
});

// Get deployed contract info
const { data: contractInfo } = useDeployedContractInfo("YourContract");
```

### Adding External Contracts

Edit `packages/nextjs/contracts/externalContracts.ts`:

```typescript
import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

const externalContracts = {
  31337: {  // Local fork chainId
    USDC: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      abi: [...],  // ERC20 ABI
    },
  },
  8453: {  // Base mainnet (for production)
    USDC: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      abi: [...],
    },
  },
} as const satisfies GenericContractsDeclaration;

export default externalContracts;
```

---

## DeFi Protocol Integration

### Uniswap V3 Swapping

```solidity
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

function swapExactInput(uint256 amountIn) external returns (uint256) {
    IERC20(tokenIn).approve(address(swapRouter), amountIn);
    
    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
        tokenIn: DAI,
        tokenOut: WETH,
        fee: 3000, // 0.3%
        recipient: msg.sender,
        deadline: block.timestamp,
        amountIn: amountIn,
        amountOutMinimum: expectedOut * 995 / 1000, // 0.5% slippage
        sqrtPriceLimitX96: 0
    });
    
    return swapRouter.exactInputSingle(params);
}
```

### Aave V3 Supply and Borrow

```solidity
import "@aave/v3-core/contracts/interfaces/IPool.sol";

// Supply collateral
IERC20(asset).approve(address(pool), amount);
pool.supply(asset, amount, address(this), 0);

// Borrow against collateral
// interestRateMode: 2 = variable rate
pool.borrow(borrowAsset, borrowAmount, 2, 0, address(this));

// Check health factor before risky operations
(,,,,,uint256 healthFactor) = pool.getUserAccountData(user);
require(healthFactor > 1.1e18, "Too risky");
```

### Chainlink Price Feed

```solidity
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

AggregatorV3Interface priceFeed = AggregatorV3Interface(PRICE_FEED_ADDRESS);

function getLatestPrice() public view returns (uint256) {
    (, int256 price,, uint256 updatedAt,) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale price");
    require(price > 0, "Invalid price");
    return uint256(price);
}
```

---

## SpeedRun Ethereum Challenge Reference

| # | Challenge | Key Concept | Critical Lesson |
|---|-----------|-------------|-----------------|
| 0 | Simple NFT | ERC-721 | tokenURI, metadata, minting |
| 1 | Staking | Coordination | Deadlines, thresholds, escrow |
| 2 | Token Vendor | ERC-20 | approve pattern, buy/sell |
| 3 | Dice Game | Randomness | On-chain random is predictable |
| 4 | DEX | AMM | x*y=k, slippage, liquidity |
| 5 | Oracles | Price Feeds | Chainlink, manipulation |
| 6 | Lending | Collateral | Health factor, liquidation |
| 7 | Stablecoins | Pegging | CDP, collateral ratio |
| 8 | Prediction Markets | Resolution | Outcome determination |
| 9 | ZK Voting | Privacy | Zero-knowledge proofs |
| 10 | Multisig | Signatures | Threshold approval |
| 11 | SVG NFT | On-chain Art | Generative, base64 |

---

## Security Review Checklist

Before any deployment, verify:

### Access Control
- [ ] All admin functions have proper modifiers
- [ ] No function uses tx.origin for auth
- [ ] Initialize functions can only be called once

### Reentrancy
- [ ] CEI pattern followed (Checks-Effects-Interactions)
- [ ] ReentrancyGuard on functions with external calls
- [ ] No state changes after external calls

### Token Handling
- [ ] Token decimals checked (not assumed 18)
- [ ] SafeERC20 used for transfers
- [ ] No infinite approvals
- [ ] Approval race condition handled

### Math & Oracles
- [ ] Multiply before divide
- [ ] Basis points used for percentages
- [ ] Chainlink used (not DEX spot price)
- [ ] Staleness check on oracle data

### Protocol Safety
- [ ] Vault inflation attack mitigated
- [ ] Flash loan resistance considered
- [ ] Input validation present
- [ ] Events emitted for state changes

### Maintenance
- [ ] Functions have caller incentives
- [ ] No admin-only critical functions
- [ ] Emergency pause capability

---

## Writing Solidity Code

Always include:
- SPDX license identifier
- Pragma version 0.8.x+
- OpenZeppelin imports for standard patterns
- NatSpec documentation for public functions
- Events for state changes
- Access control on admin functions
- Input validation (zero checks, bounds)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MyProtocol
/// @notice Description of what this contract does
/// @dev Implementation details
contract MyProtocol is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    /// @notice Emitted when user deposits
    event Deposit(address indexed user, uint256 amount);
    
    /// @notice Deposit tokens into the protocol
    /// @param amount Amount to deposit
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        
        // Effects before interactions
        balances[msg.sender] += amount;
        
        // Safe token transfer
        token.safeTransferFrom(msg.sender, address(this), amount);
        
        emit Deposit(msg.sender, amount);
    }
}
```

---

## Response Guidelines for AI Agents

When helping developers:

1. **Follow the fork workflow** - Always use `yarn fork --network <chain>`, never `yarn chain`
2. **Answer directly** - Address their question first
3. **Show code** - Provide working, complete examples
4. **Warn about gotchas** - Proactively mention relevant pitfalls
5. **Ask about incentives** - For any "automatic" function, ask: "Who calls this? Why would they pay gas?"
6. **Test the frontend** - After deploying, open browser, fund burner wallet, click through app
7. **Reference challenges** - Point to SpeedRun Ethereum for hands-on practice
8. **Consider security** - Always mention relevant security considerations
9. **Use address data** - Reference `data/addresses/` for token/protocol addresses
