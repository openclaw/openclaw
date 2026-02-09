# Automation, Incentives & Keepers

## THE MOST IMPORTANT CONCEPT IN ETHEREUM DEVELOPMENT

```
┌─────────────────────────────────────────────────────────────────┐
│ 🚨 CRITICAL INSIGHT FOR NEW BUILDERS 🚨                         │
├─────────────────────────────────────────────────────────────────┤
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

## The Reactive Nature of Ethereum

Unlike traditional servers that can run scheduled tasks, Ethereum is **purely reactive**:

```
Traditional Web App:
┌─────────────────────────────────────────────────────────────────┐
│ Server runs cron job at midnight → Process subscriptions        │
│ Timer triggers every hour → Check for expired items             │
│ Background worker → Process queue automatically                 │
└─────────────────────────────────────────────────────────────────┘

Ethereum Smart Contract:
┌─────────────────────────────────────────────────────────────────┐
│ Contract sits dormant...                                        │
│ ...waiting...                                                   │
│ ...nothing happens...                                           │
│ Someone sends transaction → Code executes → Back to dormant     │
└─────────────────────────────────────────────────────────────────┘
```

**Every single state change requires:**
1. An EOA (wallet) to initiate a transaction
2. Gas to be paid for execution
3. Someone to decide it's worth calling

## The Question You Must Always Ask

**"WHO CALLS THIS FUNCTION? WHY WOULD THEY?"**

```solidity
// You write this function:
function checkAndDistributeRewards() external {
    if (block.timestamp >= rewardTime) {
        // distribute rewards
    }
}

// Ask yourself:
// 1. Who will call this?
// 2. Why would they pay gas to call it?
// 3. What do they get in return?
// 4. What happens if NO ONE calls it?
```

## Incentive Design Patterns

### Pattern 1: Natural User Interest

The simplest case - users call functions because they want the outcome.

```solidity
// Users WANT to claim their rewards
function claimRewards() external {
    uint256 reward = pendingRewards[msg.sender];
    require(reward > 0, "No rewards");
    
    pendingRewards[msg.sender] = 0;
    rewardToken.transfer(msg.sender, reward);
}
// ✅ Incentive: User gets tokens they're owed
// ✅ Will be called: Yes, users want their money
```

```solidity
// Users WANT to withdraw their deposits
function withdraw(uint256 amount) external {
    require(deposits[msg.sender] >= amount);
    deposits[msg.sender] -= amount;
    payable(msg.sender).transfer(amount);
}
// ✅ Incentive: User gets their money back
// ✅ Will be called: Yes, when users need funds
```

### Pattern 2: Caller Rewards (Keeper Incentives)

Pay the caller for performing necessary maintenance.

```solidity
// LIQUIDATION: Caller gets bonus for liquidating unhealthy positions
function liquidate(address user) external {
    require(getHealthFactor(user) < 1e18, "Position healthy");
    
    uint256 debt = userDebt[user];
    uint256 collateral = userCollateral[user];
    
    // Liquidator pays the debt
    debtToken.transferFrom(msg.sender, address(this), debt);
    
    // Liquidator gets collateral + 5% BONUS
    uint256 bonus = (collateral * 500) / 10000;
    collateralToken.transfer(msg.sender, collateral + bonus);
    
    // Clear user's position
    userDebt[user] = 0;
    userCollateral[user] = 0;
}
// ✅ Incentive: Liquidator profits from the bonus
// ✅ Will be called: Yes, bots compete to liquidate
```

```solidity
// YIELD HARVESTING: Caller gets a cut for triggering harvest
function harvest() external {
    uint256 yield = externalProtocol.claimRewards();
    
    // Give caller 1% for triggering harvest
    uint256 callerReward = yield / 100;
    rewardToken.transfer(msg.sender, callerReward);
    
    // Rest goes to vault
    rewardToken.transfer(address(vault), yield - callerReward);
}
// ✅ Incentive: Caller gets 1% of harvested yield
// ✅ Will be called: Yes, profitable for harvesters
```

### Pattern 3: MEV Opportunities

Searchers will call functions if there's extractable value.

```solidity
// ARBITRAGE: Price difference creates opportunity
function rebalance() external {
    uint256 ourPrice = getOurPrice();
    uint256 marketPrice = getMarketPrice();
    
    if (ourPrice < marketPrice) {
        // Buy from us, sell on market
        // Arbitrageur profits from difference
    }
}
// ✅ Incentive: Arbitrage profit
// ✅ Will be called: Yes, MEV bots are always watching
```

### Pattern 4: Conditional Execution with Rewards

```solidity
// Execute user's order when price target hit
struct Order {
    address user;
    uint256 targetPrice;
    uint256 amount;
    uint256 reward;  // Bounty for executor
}

mapping(uint256 => Order) public orders;

function executeOrder(uint256 orderId) external {
    Order memory order = orders[orderId];
    uint256 currentPrice = oracle.getPrice();
    
    require(currentPrice >= order.targetPrice, "Price not reached");
    
    // Execute the trade
    _executeTrade(order.user, order.amount);
    
    // Pay the executor their reward
    payable(msg.sender).transfer(order.reward);
    
    delete orders[orderId];
}
// ✅ Incentive: Executor earns the reward bounty
// ✅ Will be called: Yes, when price target hit
```

## Real-World Examples

### DeFi Liquidations (Aave, Compound, MakerDAO)

```
How it works:
1. User borrows $80 against $100 collateral (80% LTV)
2. Collateral value drops to $90
3. Position is now undercollateralized
4. ANYONE can call liquidate()
5. Liquidator pays debt, gets collateral + 5-10% bonus
6. Liquidators run bots 24/7 competing for these opportunities

Why it works:
- Liquidators profit from the bonus
- Competition ensures quick liquidation
- Protocol stays solvent
- No central entity needed
```

### Chainlink Keepers / Gelato / Keep3r

```
Problem: Your contract needs regular maintenance
Solution: Pay a decentralized network of keepers

function checkUpkeep(bytes calldata) external view returns (bool, bytes memory) {
    // Return true if work needs to be done
    return (shouldHarvest(), "");
}

function performUpkeep(bytes calldata) external {
    require(shouldHarvest(), "Not needed");
    _harvest();
    // Keeper network pays gas, gets compensated by you
}
```

### Yield Optimizer Auto-Compounding

```
Protocol: Beefy Finance, Yearn

Every X hours, someone needs to:
1. Claim farming rewards
2. Swap to base asset
3. Reinvest into pool

Incentive: Caller gets 0.5-1% of harvested rewards
Result: Bots compete to compound, users get auto-compounding
```

## Anti-Patterns: What NOT To Do

### ❌ Expecting Automatic Execution
```solidity
// BAD: This will NEVER run automatically!
function dailyDistribution() external {
    require(block.timestamp >= lastDistribution + 1 days);
    // This sits here forever if no one calls it
}
```

### ❌ No Incentive to Call
```solidity
// BAD: Why would anyone pay gas to call this?
function updateGlobalState() external {
    // Updates state that doesn't benefit caller
    globalCounter++;
}
// Nobody will call this. Gas costs money.
```

### ❌ Admin-Only Critical Functions
```solidity
// BAD: Single point of failure
function processExpiredPositions() external onlyOwner {
    // What if admin goes offline?
    // What if admin key is lost?
    // Protocol stops working!
}

// GOOD: Anyone can call with proper incentives
function processExpiredPosition(uint256 positionId) external {
    require(positions[positionId].expiry < block.timestamp);
    // Process and reward caller
}
```

## Designing For Automation: A Checklist

When building any function that "needs to happen":

```
□ Can ANYONE call this function? (not just owner/admin)

□ Is there a clear INCENTIVE for the caller?
  - Direct payment/reward?
  - MEV opportunity?
  - Natural user interest?

□ Is the incentive SUFFICIENT to cover gas + profit?
  - On L1 mainnet, gas is expensive
  - On L2, gas is cheap but still not free

□ What happens if NO ONE calls for hours/days?
  - Does the protocol break?
  - Do users lose money?
  - Is there a fallback?

□ Could this be integrated with Chainlink Keepers/Gelato?
  - For critical maintenance functions
  - More reliable than hoping someone calls
```

## The Mental Model

Think of your smart contract as a **vending machine**:

```
Vending Machine:
- Sits there doing nothing
- Someone puts in money, presses button
- Dispenses item
- Goes back to doing nothing

Smart Contract:
- Sits there doing nothing
- Someone sends transaction with gas
- Executes code
- Goes back to doing nothing

KEY INSIGHT:
The vending machine doesn't restock itself.
Your contract doesn't maintain itself.
SOMEONE must do it, and they need a reason to.
```

## Summary

```
┌─────────────────────────────────────────────────────────────────┐
│ GOLDEN RULE OF ETHEREUM DEVELOPMENT                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ For every function that "needs to happen":                      │
│                                                                 │
│ 1. Make it callable by ANYONE                                   │
│ 2. Give callers a REASON to call (profit, reward, their stuff)  │
│ 3. Make the incentive SUFFICIENT                                │
│                                                                 │
│ If you can't answer "who calls this and why?"                   │
│ ...your function won't get called.                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
