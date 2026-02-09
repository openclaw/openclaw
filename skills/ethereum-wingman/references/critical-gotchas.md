# Critical Ethereum Development Gotchas

These are the most important gotchas that cause major bugs and exploits. Every Ethereum developer must understand these.

---

## 1. Token Decimals Vary

**CRITICAL**: Not all tokens have 18 decimals!

```
USDC, USDT: 6 decimals    → 1 USDC = 1,000,000
WBTC:       8 decimals    → 1 WBTC = 100,000,000
DAI:        18 decimals   → 1 DAI = 1,000,000,000,000,000,000
Most tokens: 18 decimals  → 1 TOKEN = 1e18
```

> **Verified**: USDC, USDT, WBTC, DAI decimals confirmed via [Etherscan](https://etherscan.io) token pages (Jan 2026)

### The Bug
```solidity
// BAD: Assumes 18 decimals
uint256 oneToken = 1e18;
token.transfer(user, oneToken); // Transfers 1 trillion USDC!

// GOOD: Check decimals
uint256 oneToken = 10 ** token.decimals();
token.transfer(user, oneToken);
```

### Real Impact
- Protocols have lost millions by assuming 18 decimals
- Always call `token.decimals()` before calculations

---

## 2. ETH is Measured in Wei

**CRITICAL**: 1 ETH = 10^18 wei

```solidity
// BAD: Sends 1 wei (almost nothing)
payable(user).transfer(1);

// GOOD: Use ether keyword or explicit conversion
payable(user).transfer(1 ether);
payable(user).transfer(1e18);
```

### Common Mistake
```solidity
// Sending "100 ETH" but actually 100 wei
function tip() external payable {
    require(msg.value >= 100, "Min 100"); // This is 100 wei!
}

// Correct
function tip() external payable {
    require(msg.value >= 0.1 ether, "Min 0.1 ETH");
}
```

---

## 3. ERC-20 Approve Pattern Required

**CRITICAL**: Contracts cannot pull tokens without approval!

```
Two-step process:
1. User calls token.approve(spender, amount)
2. Spender calls token.transferFrom(user, ..., amount)
```

### Never Use Infinite Approvals
```solidity
// DANGEROUS: Allows draining all tokens
token.approve(spender, type(uint256).max);

// SAFE: Approve exact amount needed
token.approve(spender, exactAmount);
```

### Approval Race Condition
```solidity
// If changing approval from 100 to 50:
// Attacker can: spend 100, wait for tx, spend 50 more

// Safe pattern: Reset to 0 first
token.approve(spender, 0);
token.approve(spender, newAmount);
```

---

## 4. Solidity Has No Floating Point

**CRITICAL**: No decimals, no floats, only integers!

```solidity
// BAD: This is 0, not 0.05
uint256 fivePercent = 5 / 100;

// GOOD: Use basis points (1 bp = 0.01%)
uint256 fivePercentBps = 500; // 5% = 500 basis points
uint256 fee = (amount * fivePercentBps) / 10000;

// GOOD: Multiply before divide
uint256 fee = (amount * 5) / 100;
```

### Precision Loss
```solidity
// BAD: Loses precision
uint256 result = a / b * c;

// GOOD: Multiply first
uint256 result = (a * c) / b;
```

---

## 5. Nothing is Automatic

**CRITICAL**: Smart contracts cannot execute themselves!

```
No cron jobs, no timers, no automatic triggers.
Someone must call the function and pay gas.
```

### Who Calls Your Function?
```solidity
// This won't run automatically at deadline!
function checkDeadline() external {
    if (block.timestamp >= deadline) {
        // Execute...
    }
}
```

### Design Incentives
```solidity
// Give callers a reason to call
function liquidate(address user) external {
    // Liquidator gets bonus collateral
    uint256 bonus = collateral * 5 / 100;
    collateral.transfer(msg.sender, debt + bonus);
}

// Or rely on natural interest
function claimRewards() external {
    // Users want their rewards
    uint256 reward = calculateReward(msg.sender);
    rewardToken.transfer(msg.sender, reward);
}
```

---

## 6. Reentrancy Attacks

**CRITICAL**: External calls can call back into your contract!

```solidity
// VULNERABLE
function withdraw() external {
    uint256 balance = balances[msg.sender];
    (bool success, ) = msg.sender.call{value: balance}("");
    require(success);
    balances[msg.sender] = 0; // Too late! Attacker already re-entered
}

// SAFE: Checks-Effects-Interactions
function withdraw() external {
    uint256 balance = balances[msg.sender];
    balances[msg.sender] = 0; // Effect BEFORE interaction
    (bool success, ) = msg.sender.call{value: balance}("");
    require(success);
}
```

### Use ReentrancyGuard
```solidity
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Safe is ReentrancyGuard {
    function withdraw() external nonReentrant {
        // Protected from reentrancy
    }
}
```

---

## 7. Never Use DEX Spot Prices as Oracles

**CRITICAL**: Flash loans can manipulate spot prices instantly!

```solidity
// VULNERABLE: Can be manipulated with flash loan
function getPrice() internal view returns (uint256) {
    return dex.getSpotPrice(); // Manipulable!
}

// SAFE: Use Chainlink
function getPrice() internal view returns (uint256) {
    (, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale");
    require(price > 0, "Invalid");
    return uint256(price);
}
```

### Attack Pattern
```
1. Flash loan 1M ETH
2. Swap on DEX → crash price
3. Borrow against "cheap" collateral
4. Swap back → restore price
5. Repay flash loan, keep profit
```

---

## 8. Vault Inflation Attack (First Depositor)

**CRITICAL**: First depositor can manipulate share price!

```solidity
// ATTACK:
// 1. Deposit 1 wei → get 1 share
// 2. Donate 10000 tokens directly (not through deposit)
// 3. Share price = 10001 / 1 = 10001 per share
// 4. Victim deposits 9999 → gets 0 shares (rounded down)
// 5. Attacker redeems 1 share → gets all 20000 tokens
```

### Mitigations
```solidity
// Option 1: Virtual offset
function convertToShares(uint256 assets) public view returns (uint256) {
    return assets.mulDiv(totalSupply() + 1e3, totalAssets() + 1);
}

// Option 2: Dead shares
constructor() {
    _mint(address(0), 1000); // Burn initial shares
}

// Option 3: Minimum deposit
function deposit(uint256 assets) external {
    require(assets >= MIN_DEPOSIT, "Too small");
}
```

---

## 9. Access Control Missing

**CRITICAL**: Anyone can call unprotected functions!

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

### Common Mistakes
- Forgetting `onlyOwner` on admin functions
- Using `tx.origin` instead of `msg.sender`
- Not checking caller in callbacks

---

## 10. Integer Overflow (Pre-0.8)

**NOTE**: Solidity 0.8+ has built-in overflow checks, but watch for `unchecked` blocks!

```solidity
// Pre-0.8 VULNERABLE
uint8 x = 255;
x += 1; // x = 0 (overflow!)

// 0.8+ SAFE (reverts)
uint8 x = 255;
x += 1; // Reverts!

// 0.8+ DANGEROUS if using unchecked
unchecked {
    uint8 x = 255;
    x += 1; // x = 0 again!
}
```

---

## 11. Unchecked Return Values

**CRITICAL**: Some tokens don't return bool on transfer!

```solidity
// VULNERABLE: USDT doesn't return bool
bool success = token.transfer(to, amount); // Might not compile or return false

// SAFE: Use SafeERC20
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
using SafeERC20 for IERC20;

token.safeTransfer(to, amount); // Handles non-standard tokens
```

---

## 12. Timestamp Dependence

**CRITICAL**: Miners can manipulate timestamps by ~15 seconds!

```solidity
// VULNERABLE for precise timing
require(block.timestamp == exactTime); // Miner can manipulate

// SAFE for approximate timing (hours/days)
require(block.timestamp >= deadline); // OK for deadlines
```

### Don't Use For
- Randomness
- Precise scheduling
- High-value time-sensitive operations

### OK For
- Lockup periods (days/weeks)
- General deadlines
- Time-weighted averages

---

## Quick Reference Checklist

- [ ] Check token decimals before calculations
- [ ] Handle ETH in wei (use `1 ether` syntax)
- [ ] Approve exact amounts, never infinite
- [ ] Multiply before divide for precision
- [ ] Design incentives for function callers
- [ ] Use CEI pattern + ReentrancyGuard
- [ ] Use Chainlink, not DEX spot prices
- [ ] Protect vaults from inflation attacks
- [ ] Add access control to admin functions
- [ ] Use SafeERC20 for token transfers
- [ ] Don't rely on precise timestamps
