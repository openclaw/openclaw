# Historical Hacks: Teachable Moments

Learning from past exploits is essential for building secure protocols. Each hack here is a lesson in what NOT to do.

---

## The DAO Hack (2016) - $50M

> **Verified**: Amount confirmed via [Wikipedia](https://en.wikipedia.org/wiki/The_DAO) - 3.6M ETH (~$50M at time) (Jan 2026)

### What Happened
The first major Ethereum exploit. Attacker drained ~$50M (3.6 million ETH, about 1/3 of the 11.5M ETH in The DAO) using a reentrancy attack.

### The Vulnerable Code
```solidity
// Simplified vulnerable pattern
function withdraw() external {
    uint256 balance = balances[msg.sender];
    
    // External call BEFORE state update
    (bool success, ) = msg.sender.call{value: balance}("");
    require(success);
    
    // State updated AFTER - attacker already re-entered!
    balances[msg.sender] = 0;
}
```

### The Attack
```solidity
contract Attacker {
    DAO public dao;
    
    function attack() external {
        dao.withdraw();
    }
    
    // This gets called when DAO sends ETH
    receive() external payable {
        if (address(dao).balance > 0) {
            dao.withdraw(); // Re-enter before balance zeroed
        }
    }
}
```

### The Fix: Checks-Effects-Interactions
```solidity
function withdraw() external {
    uint256 balance = balances[msg.sender];
    
    // Effect BEFORE interaction
    balances[msg.sender] = 0;
    
    // Interaction AFTER effects
    (bool success, ) = msg.sender.call{value: balance}("");
    require(success);
}
```

### Lesson
- Always update state BEFORE external calls
- Use ReentrancyGuard for all functions with external calls
- The Ethereum community hard-forked to reverse this hack

---

## bZx Flash Loan Attack (2020) - ~$1M

> **Verified**: Amounts confirmed via [rekt.news](https://rekt.news/bzx-rekt/) - Two attacks: $298K + $645K (~$943K total) (Jan 2026)

### What Happened
Attacker used flash loans to manipulate oracle prices and borrow against artificially inflated collateral. This was one of the first flash loan exploits.

### The Attack Flow
```
1. Flash loan 10,000 ETH
2. Deposit 5,000 ETH as collateral on bZx
3. Short ETH on bZx (borrow + sell)
4. Use remaining 5,000 ETH to crash ETH price on Uniswap
5. bZx uses Uniswap spot price as oracle
6. Short position now massively profitable
7. Close short, repay flash loan, keep profit
```

### The Vulnerable Pattern
```solidity
// NEVER DO THIS
function getPrice() internal view returns (uint256) {
    // Using DEX spot price as oracle
    (uint112 reserve0, uint112 reserve1, ) = uniswapPair.getReserves();
    return (reserve1 * 1e18) / reserve0;
}
```

### The Fix: Use Decentralized Oracles
```solidity
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

function getPrice() internal view returns (uint256) {
    (, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();
    require(block.timestamp - updatedAt < 3600, "Stale price");
    require(price > 0, "Invalid price");
    return uint256(price);
}
```

### Lesson
- NEVER use spot DEX prices for anything valuable
- Flash loans make any single-block manipulation possible
- Use Chainlink or TWAPs (Time-Weighted Average Prices)

---

## Nomad Bridge Hack (2022) - $190M

> **Verified**: Amount confirmed via [rekt.news leaderboard](https://rekt.news/leaderboard/) (Jan 2026)

### What Happened
A routine upgrade introduced a bug that allowed anyone to drain the bridge by copying successful transactions.

### The Bug
After an upgrade, the zero hash `0x00` was marked as a valid root in the Merkle tree verification.

```solidity
// The problematic change
function process(bytes memory _message) external {
    bytes32 _messageHash = keccak256(_message);
    
    // BUG: acceptableRoot[0x00] was true after upgrade!
    require(acceptableRoot[messages[_messageHash]], "Invalid root");
    
    // Process withdrawal...
}
```

### The Attack
```
1. Find a successful bridge transaction
2. Copy it, change only the recipient address
3. Submit - the zero root was accepted as valid
4. Repeat for any asset in the bridge
5. Others saw the technique and joined the "looting"
```

### The Lesson
```solidity
// Proper Merkle verification
function process(bytes32 _messageHash, bytes32 _root, bytes32[] memory _proof) external {
    // Verify root is in the set of accepted roots
    require(acceptableRoot[_root], "Unknown root");
    require(_root != bytes32(0), "Invalid root"); // Explicit zero check
    
    // Verify the proof
    require(MerkleProof.verify(_proof, _root, _messageHash), "Invalid proof");
}
```

### Lesson
- Always validate against zero values explicitly
- Test upgrade paths thoroughly
- Bridge contracts are high-value targets

---

## Alchemix Incident (2021) - $6.5M

> **Verified**: Amount confirmed via [rekt.news](https://rekt.news/alchemix-rekt/) - ~2700 ETH (~$6.5M) (Jan 2026)

### What Happened
A bug in the alETH vault caused the protocol to assign zero debt to users, allowing them to withdraw their collateral while keeping their borrowed alETH. This was NOT a precision error - it was a logic bug that incorrectly cleared user debt.

### The Vulnerable Pattern
```solidity
// Simplified vulnerable calculation
function calculateReward(address user) internal view returns (uint256) {
    // Division truncation compounds over many operations
    uint256 reward = (userBalance * rewardRate) / totalBalance;
    return reward * multiplier / divisor; // More precision loss
}
```

### The Fix: Proper Fixed-Point Math
```solidity
// Use high precision (e.g., 1e18 scale)
uint256 constant PRECISION = 1e18;

function calculateReward(address user) internal view returns (uint256) {
    // Scale up for precision
    uint256 scaledReward = (userBalance * rewardRate * PRECISION) / totalBalance;
    // Scale back down at the end
    return scaledReward / PRECISION;
}
```

### Lessons
- Always multiply before dividing
- Use high-precision intermediate calculations
- Round in favor of the protocol, not users
- Test edge cases with real numbers

---

## Cream Finance (2021) - $130M

> **Verified**: Amount confirmed via [rekt.news leaderboard](https://rekt.news/leaderboard/) (Jan 2026)

### What Happened
Attacker exploited price oracle manipulation combined with flash loans across multiple DeFi protocols.

### The Attack Pattern
```
1. Flash loan massive amounts
2. Manipulate token price on lending platform
3. Borrow against inflated collateral
4. Let the position become undercollateralized
5. Liquidate yourself, repay flash loan
```

### Vulnerable Oracle Pattern
```solidity
// BAD: Single-source price
function getPrice(address token) external view returns (uint256) {
    return singleDEX.getPrice(token);
}

// BETTER: Multi-source with sanity checks
function getPrice(address token) external view returns (uint256) {
    uint256 chainlinkPrice = chainlinkFeed.getPrice(token);
    uint256 twapPrice = uniswapTwap.consult(token, 30 minutes);
    
    // Sanity check: prices should be within 5%
    require(
        chainlinkPrice * 95 / 100 <= twapPrice &&
        twapPrice <= chainlinkPrice * 105 / 100,
        "Price deviation"
    );
    
    return chainlinkPrice;
}
```

### Lessons
- Use multiple oracle sources
- Implement price deviation checks
- Add cooldown periods for large operations
- Flash loan resistance requires multi-block delays

---

## Poly Network (2021) - $611M

> **Verified**: Amount confirmed via [rekt.news leaderboard](https://rekt.news/leaderboard/) (Jan 2026)

### What Happened
Attacker found they could call privileged functions by crafting specific cross-chain messages.

### The Bug
```solidity
// Vulnerable: No validation of who is calling privileged function
function _executeCrossChainTx(
    bytes memory _method,
    bytes memory _args
) internal {
    // This could call ANY function, including changing the keeper!
    (bool success, ) = address(this).call(abi.encodePacked(_method, _args));
}
```

### The Attack
Attacker crafted a message that called the function to change the privileged signer to their own address.

### The Fix
```solidity
// SAFE: Whitelist allowed functions
mapping(bytes4 => bool) public allowedFunctions;

function _executeCrossChainTx(bytes memory _method, bytes memory _args) internal {
    bytes4 selector = bytes4(keccak256(_method));
    require(allowedFunctions[selector], "Function not allowed");
    
    // Never allow calling admin functions
    require(selector != this.changeOwner.selector, "Cannot change owner");
    
    (bool success, ) = address(this).call(abi.encodePacked(_method, _args));
}
```

### Lessons
- Whitelist allowed operations, don't blacklist
- Never allow arbitrary function calls
- Cross-chain messaging requires extreme care
- Admin functions need multiple layers of protection

---

## Wormhole (2022) - $326M

> **Verified**: Amount confirmed via [rekt.news leaderboard](https://rekt.news/leaderboard/) (Jan 2026)

### What Happened
Attacker bypassed signature verification to mint unbacked wrapped tokens.

### The Bug
A deprecated function was still accessible that didn't properly verify signatures.

```solidity
// The deprecated but still callable function
function complete_transfer(bytes memory vaa) external {
    // Missing: Proper guardian signature verification
    // The old verification was incomplete
}
```

### Lessons
- Remove deprecated code completely
- Multiple audit checkpoints for bridges
- Signature verification is critical infrastructure
- One bug in a bridge = catastrophic loss

---

## Common Attack Patterns Summary

| Pattern | Example Hacks | Prevention |
|---------|---------------|------------|
| Reentrancy | The DAO | CEI pattern, ReentrancyGuard |
| Oracle Manipulation | bZx, Cream | Chainlink, TWAPs, multi-oracle |
| Access Control | Poly Network | Proper modifiers, whitelist functions |
| Flash Loan Attacks | bZx, Cream | Multi-block delays, oracle protection |
| Precision/Rounding | Alchemix | Multiply first, high precision math |
| Bridge Exploits | Nomad, Wormhole | Multiple audits, gradual rollout |

---

## What to Do Before Mainnet

1. **Multiple Audits**: Different teams catch different bugs
2. **Bug Bounty**: Incentivize white hats
3. **Gradual Rollout**: Cap initial TVL
4. **Monitoring**: Real-time alerts for anomalies
5. **Emergency Pause**: Ability to stop if exploit detected
6. **Insurance**: Consider coverage for users
