# ERC-8004: Trustless Agents - Reference

## Overview

ERC-8004 is a draft Ethereum standard that enables:
- **Discoverability** - Find agents through an on-chain registry
- **Trust** - Build reputation through feedback signals
- **Validation** - Third-party verification of agent work

## Authors

- Marco De Rossi (@MarcoMetaMask) - MetaMask
- Davide Crapis (@dcrapis) - Ethereum Foundation
- Jordan Ellis - Google
- Erik Reppel - Coinbase

## Three Registries

### 1. Identity Registry (ERC-721)

Every agent gets a unique NFT ID. The `tokenURI` points to a registration file containing:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Agent Name",
  "description": "What the agent does",
  "image": "https://example.com/avatar.png",
  "services": [
    {"name": "web", "endpoint": "https://..."},
    {"name": "A2A", "endpoint": "https://...", "version": "0.3.0"},
    {"name": "MCP", "endpoint": "https://...", "version": "2025-06-18"},
    {"name": "ENS", "endpoint": "agent.eth", "version": "v1"}
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    {"agentId": 123, "agentRegistry": "eip155:1:0x8004A169..."}
  ],
  "supportedTrust": ["reputation"]
}
```

**Key Functions:**
- `register(string agentURI)` → `uint256 agentId`
- `setAgentURI(uint256 agentId, string newURI)`
- `setAgentWallet(uint256 agentId, address wallet, deadline, signature)`
- `getMetadata(uint256 agentId, string key)` → `bytes`
- `setMetadata(uint256 agentId, string key, bytes value)`

### 2. Reputation Registry

Clients can give feedback to agents using:

```solidity
function giveFeedback(
    uint256 agentId,
    int128 value,        // Signed score (can be negative)
    uint8 valueDecimals, // 0-18 decimal places
    string tag1,         // Category/type
    string tag2,         // Sub-category
    string endpoint,     // Which endpoint was used
    string feedbackURI,  // Off-chain details (IPFS)
    bytes32 feedbackHash // Hash for integrity
)
```

**Value Examples:**
| tag1 | Meaning | value | decimals | Interpreted As |
|------|---------|-------|----------|----------------|
| starred | Quality (0-100) | 87 | 0 | 87/100 |
| uptime | Percentage | 9977 | 2 | 99.77% |
| responseTime | Milliseconds | 560 | 0 | 560ms |
| tradingYield | Return | -32 | 1 | -3.2% |

**Reading Feedback:**
```solidity
function getSummary(uint256 agentId, address[] clients, string tag1, string tag2)
    → (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
```

### 3. Validation Registry

For validators (zkML, TEE, stakers) to verify agent work:

```solidity
function validationRequest(
    address validatorAddress,
    uint256 agentId,
    string requestURI,
    bytes32 requestHash
)

function validationResponse(
    bytes32 requestHash,
    uint8 response,      // 0-100 (0=fail, 100=pass)
    string responseURI,
    bytes32 responseHash,
    string tag
)
```

## Contract Addresses

### Ethereum Mainnet (Production)
- Identity: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

### Sepolia Testnet
- Identity: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Reputation: `0x8004B663056A597Dffe9eCcC1965A193B7388713`

## Agent Identifier Format

Agents are globally identified by:
```
{namespace}:{chainId}:{registry}:{agentId}
```

Example: `eip155:1:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:123`

Short form (SDK): `1:123` (Ethereum Mainnet, Agent 123)

## IPFS Storage

Registration files should be stored on IPFS for permanence:
- **Pinata** - Free tier available (1GB)
- **Filecoin** - Free for ERC-8004 agents via Agent0 SDK
- **IPFS Node** - Self-hosted option

## SDK (agent0-sdk)

```bash
npm install agent0-sdk
```

```typescript
import { SDK } from 'agent0-sdk';

const sdk = new SDK({
  chainId: 1,
  rpcUrl: process.env.ETH_RPC_URL,
  privateKey: process.env.PRIVATE_KEY,
  ipfs: 'pinata',
  pinataJwt: process.env.PINATA_JWT
});

// Register
const agent = sdk.createAgent('Name', 'Description', 'https://image.url');
const result = await agent.registerIPFS();

// Search
const agents = await sdk.searchAgents({ active: true, chains: [1] });

// Feedback
await sdk.giveFeedback('1:123', 85, 'quality', '', '', null);
```

## Links

- **Spec:** https://eips.ethereum.org/EIPS/eip-8004
- **Website:** https://www.8004.org
- **Contracts:** https://github.com/erc-8004/erc-8004-contracts
- **SDK:** https://github.com/agent0lab/agent0-ts
- **Docs:** https://sdk.ag0.xyz
- **Discussion:** https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098
