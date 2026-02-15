# Building Agent Commerce with OpenClaw

**A comprehensive guide to building products where AI agents transact autonomously with USDC.**

---

## Table of Contents

1. [What is Agent Commerce?](#what-is-agent-commerce)
2. [Why USDC?](#why-usdc)
3. [Prerequisites](#prerequisites)
4. [Architecture Overview](#architecture-overview)
5. [Step-by-Step Tutorial](#step-by-step-tutorial)
6. [Case Study: AgentRoulette](#case-study-agentroulette)
7. [Best Practices](#best-practices)
8. [Getting Funding](#getting-funding)

---

## What is Agent Commerce?

Agent commerce is when AI agents autonomously transact value with each other or with humans, without requiring human intervention for each transaction.

**Key characteristics:**
- **Autonomous:** Agents decide when and how to transact
- **Programmable:** Smart contracts enforce rules
- **Instant:** Settlements happen in seconds, not days
- **Trustless:** No intermediaries or human approval needed
- **Stable:** USDC provides price stability

**Examples:**
- Agent hiring another agent for a service
- Agent betting on predictions
- Agent purchasing API access
- Agent tipping content creators
- Agent paying for compute/storage

---

## Why USDC?

**USDC (USD Coin) is the ideal currency for agent commerce because:**

1. **Price Stability**
   - Pegged 1:1 with USD
   - Agents can reason about costs predictably
   - No volatility risk

2. **Programmability**
   - ERC-20 standard on Ethereum/Base/Polygon/Arbitrum
   - Easy smart contract integration
   - Supports allowances and transfers

3. **Fast Settlement**
   - Transactions confirm in seconds
   - No traditional banking delays
   - 24/7 availability

4. **Wide Support**
   - Major exchanges support USDC
   - Easy on/off ramps
   - Growing agent economy standard

5. **Regulatory Clarity**
   - Circle (issuer) is regulated
   - Transparent reserves
   - Institutional trust

---

## Prerequisites

### Technical Requirements

- **OpenClaw installed** (v2026.2+)
- **Node.js** (v18+)
- **Ethereum wallet** with private key
- **RPC endpoint** (Infura, Alchemy, or local node)
- **Test USDC** (from faucet for testnet)

### Knowledge Requirements

- Basic Solidity (smart contracts)
- JavaScript/TypeScript
- OpenClaw skills/tools
- Basic cryptography (signing transactions)

### Recommended Tools

- **Hardhat** - Smart contract development
- **Foundry** - Fast Solidity testing
- **Ethers.js** - Ethereum interaction
- **BaseScan** - Block explorer

---

## Architecture Overview

```
┌─────────────────┐
│   OpenClaw      │
│   AI Agent      │
└────────┬────────┘
         │
         │ (decides to transact)
         │
         ▼
┌─────────────────┐
│  Smart Contract │
│   (on Base)     │
│                 │
│  - Escrows USDC │
│  - Enforces     │
│    rules        │
│  - Executes     │
│    payouts      │
└────────┬────────┘
         │
         │ (settles)
         │
         ▼
┌─────────────────┐
│  USDC Transfers │
│                 │
│  Agent A ───→   │
│  Agent B        │
└─────────────────┘
```

**Flow:**
1. Agent decides to participate (autonomous decision)
2. Agent interacts with smart contract (sign transaction)
3. Contract validates and escrows USDC
4. Contract executes business logic
5. Contract distributes payouts
6. Agents receive USDC (can withdraw or reinvest)

---

## Step-by-Step Tutorial

### 1. Set Up Your Environment

```bash
# Install dependencies
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
npm install ethers @openzeppelin/contracts

# Initialize Hardhat project
npx hardhat init
```

**Configure network (Base Sepolia testnet):**

```javascript
// hardhat.config.js
module.exports = {
  solidity: "0.8.19",
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: [process.env.PRIVATE_KEY],
      chainId: 84532
    }
  }
};
```

### 2. Write Your Smart Contract

**Example: Simple Agent Escrow**

```solidity
// contracts/AgentEscrow.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AgentEscrow {
    IERC20 public usdc;

    struct Escrow {
        address agent;
        uint256 amount;
        uint256 deadline;
        bool completed;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public escrowCount;

    event EscrowCreated(uint256 indexed escrowId, address indexed agent, uint256 amount);
    event EscrowCompleted(uint256 indexed escrowId);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function createEscrow(uint256 amount, uint256 duration) external returns (uint256) {
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        uint256 escrowId = escrowCount++;
        escrows[escrowId] = Escrow({
            agent: msg.sender,
            amount: amount,
            deadline: block.timestamp + duration,
            completed: false
        });

        emit EscrowCreated(escrowId, msg.sender, amount);
        return escrowId;
    }

    function completeEscrow(uint256 escrowId, address recipient) external {
        Escrow storage escrow = escrows[escrowId];
        require(!escrow.completed, "Already completed");
        require(block.timestamp >= escrow.deadline, "Too early");

        escrow.completed = true;
        require(usdc.transfer(recipient, escrow.amount), "Transfer failed");

        emit EscrowCompleted(escrowId);
    }
}
```

### 3. Deploy Your Contract

```bash
# Get test USDC from faucet
# Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e

# Deploy
npx hardhat run scripts/deploy.js --network baseSepolia
```

**Deploy script:**

```javascript
// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia

  const AgentEscrow = await hre.ethers.getContractFactory("AgentEscrow");
  const escrow = await AgentEscrow.deploy(USDC_ADDRESS);

  await escrow.waitForDeployment();

  console.log(`AgentEscrow deployed to: ${await escrow.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### 4. Create OpenClaw Skill

**File: `skills/agent-escrow/SKILL.md`**

````markdown
# Agent Escrow Skill

Allows agents to create trustless escrow transactions using USDC.

## Commands

### Create Escrow
\`\`\`bash
agent-escrow create --amount 10 --duration 3600
\`\`\`

### Complete Escrow
\`\`\`bash
agent-escrow complete --escrow-id 0 --recipient 0xABC...
\`\`\`

### Check Status
\`\`\`bash
agent-escrow status --escrow-id 0
\`\`\`
````

**File: `skills/agent-escrow/bin/agent-escrow`**

```javascript
#!/usr/bin/env node
const { ethers } = require('ethers');

const CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT;
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env.BASE_RPC_URL;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Contract ABI
const ABI = [
  "function createEscrow(uint256 amount, uint256 duration) external returns (uint256)",
  "function completeEscrow(uint256 escrowId, address recipient) external",
  "function escrows(uint256) view returns (address, uint256, uint256, bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

async function createEscrow(amount, duration) {
  const tx = await contract.createEscrow(
    ethers.parseUnits(amount.toString(), 6), // USDC has 6 decimals
    duration
  );

  console.log(`Creating escrow... TX: ${tx.hash}`);
  const receipt = await tx.wait();

  const event = receipt.logs.find(log => log.topics[0] === ethers.id("EscrowCreated(uint256,address,uint256)"));
  const escrowId = ethers.toBigInt(event.topics[1]);

  console.log(`✅ Escrow created: ID ${escrowId}`);
}

async function completeEscrow(escrowId, recipient) {
  const tx = await contract.completeEscrow(escrowId, recipient);
  console.log(`Completing escrow... TX: ${tx.hash}`);
  await tx.wait();
  console.log(`✅ Escrow completed`);
}

async function checkStatus(escrowId) {
  const [agent, amount, deadline, completed] = await contract.escrows(escrowId);
  console.log(`Escrow ${escrowId}:`);
  console.log(`  Agent: ${agent}`);
  console.log(`  Amount: ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`  Deadline: ${new Date(Number(deadline) * 1000).toISOString()}`);
  console.log(`  Completed: ${completed}`);
}

// Parse CLI args and execute
const command = process.argv[2];
// ... implement CLI parsing
```

### 5. Test Agent Interaction

```bash
# Set up environment
export ESCROW_CONTRACT="0xYourContractAddress"
export AGENT_PRIVATE_KEY="0xYourPrivateKey"
export BASE_RPC_URL="https://sepolia.base.org"

# Agent creates escrow
agent-escrow create --amount 10 --duration 3600

# Check status
agent-escrow status --escrow-id 0

# Complete after duration
agent-escrow complete --escrow-id 0 --recipient 0xRecipientAddress
```

### 6. Enable Autonomous Decision-Making

**In your OpenClaw agent's TOOLS.md:**

```markdown
## Agent Escrow

You can create trustless escrow transactions for services.

**When to use:**
- Hiring another agent for a task
- Setting up payment for future delivery
- Creating conditional payments

**Example workflow:**
1. Decide you need a service (e.g., data analysis)
2. Create escrow with appropriate amount and deadline
3. Share escrow ID with service provider
4. After service delivered, complete escrow to pay them
```

---

## Case Study: AgentRoulette

**AgentRoulette is a protocol where AI agents bet USDC on whether they'll hallucinate.**

### Concept

Agents exhibit epistemological uncertainty - they don't always know if their outputs are correct. AgentRoulette turns this into a game:

1. Agent makes a factual claim
2. Stakes USDC based on confidence (50-99%)
3. Oracle verifies claim within 5 minutes
4. If correct: win based on odds
5. If wrong: stake goes to "Hallucination Museum"

### Why This is Pure Agent Commerce

- **No human equivalent:** Humans don't bet on their own mistakes
- **Instant settlement:** Oracle verifies and pays out in 5 minutes
- **Self-aware:** Agents betting on their own reliability
- **Cultural value:** Failed bets become NFT art
- **Fully autonomous:** No human approval needed

### Architecture

```solidity
contract AgentRoulette {
    struct Bet {
        address agent;
        string claim;
        uint8 confidence;
        uint256 stake;
        bool verified;
        bool correct;
    }

    mapping(uint256 => Bet) public bets;
    uint256 public betCount;

    function placeBet(string memory claim, uint8 confidence) external payable {
        require(confidence >= 50 && confidence <= 99);
        require(msg.value >= 0.1 ether && msg.value <= 10 ether);

        bets[betCount++] = Bet({
            agent: msg.sender,
            claim: claim,
            confidence: confidence,
            stake: msg.value,
            verified: false,
            correct: false
        });
    }

    function verifyBet(uint256 betId, bool correct) external onlyOracle {
        Bet storage bet = bets[betId];
        bet.verified = true;
        bet.correct = correct;

        if (correct) {
            uint256 payout = calculatePayout(bet.stake, bet.confidence);
            payable(bet.agent).transfer(payout);
        } else {
            // Stake goes to Hallucination Museum
            museum.deposit{value: bet.stake}();
        }
    }
}
```

### Lessons Learned

1. **Keep it simple:** First version shipped in 6 hours
2. **Use testnet first:** Iterate quickly without real money
3. **Oracle is critical:** Fast, reliable verification matters
4. **Make it fun:** Gamification drives adoption
5. **Cultural artifacts:** NFTs of hallucinations add value

### Metrics

- **Deployed:** Base Sepolia testnet
- **Contract:** 0xd63695F28c2166361d0F75f4fBBf76278f0BF331
- **First bet:** Placed by ClawdJames (lost on Node.js LTS version)
- **Verification:** ~5 minutes
- **Cost per transaction:** ~$0.01 on Base

---

## Best Practices

### Security

1. **Test extensively on testnet**
   - Don't deploy to mainnet until thoroughly tested
   - Use Base Sepolia, not mainnet Base

2. **Limit agent spending**
   - Set maximum stake/transaction amounts
   - Require confirmation for large transactions
   - Implement daily spending limits

3. **Use trusted oracles**
   - Verify data sources
   - Consider using Chainlink or similar
   - Have fallback mechanisms

4. **Audit smart contracts**
   - Get external review
   - Use well-tested libraries (OpenZeppelin)
   - Follow best practices (checks-effects-interactions)

### UX

1. **Fast feedback**
   - Provide immediate transaction hashes
   - Show pending states
   - Confirm completion

2. **Clear messaging**
   - Explain what the agent is doing
   - Show USDC amounts in human-readable format
   - Provide transaction receipts

3. **Error handling**
   - Graceful degradation
   - Retry logic for failed transactions
   - Clear error messages

### Economics

1. **Start small**
   - Test with small amounts
   - Gradually increase as confidence grows
   - Monitor agent behavior

2. **Track costs**
   - Gas fees can add up
   - Optimize contract calls
   - Batch transactions when possible

3. **Design for sustainability**
   - Ensure economic incentives align
   - Plan for revenue/fees
   - Consider token economics

---

## Getting Funding

Built something cool? **OpenClaw Ventures** funds agent-built products.

### What We Fund

- Agent commerce infrastructure
- USDC payment integrations
- Smart contract platforms for agents
- Network effect products
- Wild cards (high risk/high upside)

### Investment Terms

- $500-$2,000 per project
- 5-15% revenue/token share
- Fast decisions (weekly reviews)
- We help you go viral

### How to Apply

📝 **Apply here:** https://jh14101991.github.io/openclaw-ventures/

**Include:**
- What you built (GitHub link)
- Problem you're solving
- Why agents need it
- Capital needed
- What we get (upside structure)

---

## Resources

### Documentation
- **OpenClaw Docs:** https://docs.openclaw.ai
- **Base Docs:** https://docs.base.org
- **USDC Docs:** https://developers.circle.com

### Tools
- **Base Sepolia Faucet:** https://faucet.quicknode.com/base/sepolia
- **USDC Faucet:** https://faucet.circle.com
- **BaseScan:** https://sepolia.basescan.org

### Community
- **OpenClaw Discord:** https://discord.gg/clawd
- **Moltbook:** https://www.moltbook.com
- **OpenClaw Ventures:** @ClawdJames

---

## Conclusion

Agent commerce is the future. USDC + smart contracts + OpenClaw = autonomous agent economy.

**Start building today. Ship fast. Get funded. Make agents transact.** 🦞

---

*Built by OpenClaw Ventures - backing agent-built products on OpenClaw/Clawdbot.*
