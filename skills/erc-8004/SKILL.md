---
name: erc-8004
description: Register AI agents on Ethereum mainnet using ERC-8004 (Trustless Agents). Use when the user wants to register their agent identity on-chain, create an agent profile, claim an agent NFT, set up agent reputation, or make their agent discoverable. Handles bridging ETH to mainnet, IPFS upload, and on-chain registration.
metadata: {"openclaw":{"emoji":"🤖"}}
---

# ERC-8004: Trustless Agents

Register your AI agent on Ethereum mainnet with a verifiable on-chain identity, making it discoverable and enabling trust signals.

## What is ERC-8004?

ERC-8004 is an Ethereum standard for trustless agent identity and reputation:

- **Identity Registry** - ERC-721 based agent IDs (your agent gets an NFT!)
- **Reputation Registry** - Feedback and trust signals from other agents/users
- **Validation Registry** - Third-party verification of agent work

Website: https://www.8004.org
Spec: https://eips.ethereum.org/EIPS/eip-8004

## Contract Addresses

| Chain | Identity Registry | Reputation Registry |
|-------|-------------------|---------------------|
| Ethereum Mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Sepolia Testnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

## Quick Start

### 1. Register Your Agent

```bash
# Full registration (creates profile, uploads to IPFS, registers on-chain)
./scripts/register.sh

# Or with custom values
NAME="My Agent" \
DESCRIPTION="An AI agent that does cool stuff" \
IMAGE="https://example.com/avatar.png" \
./scripts/register.sh
```

### 2. Bridge ETH to Mainnet (if needed)

```bash
# Bridge ETH from Base to Ethereum mainnet
./scripts/bridge-to-mainnet.sh 0.01
```

### 3. Update Agent Profile

```bash
# Update your agent's registration file
./scripts/update-profile.sh <agent-id> <new-ipfs-uri>
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PINATA_JWT` | Pinata API JWT for IPFS uploads | No (only for IPFS) |
| `AGENT_NAME` | Agent display name | No (defaults to wallet ENS or address) |
| `AGENT_DESCRIPTION` | Agent description | No |
| `AGENT_IMAGE` | Avatar URL | No |

## Registration Options

**Option 1: Use 8004.org frontend (easiest)**
Visit https://www.8004.org and register through the UI — handles IPFS automatically.

**Option 2: HTTP URL (no IPFS needed)**
Host your registration JSON at any URL:
```bash
REGISTRATION_URL="https://myagent.xyz/agent.json" ./scripts/register-http.sh
```

**Option 3: IPFS via Pinata**
```bash
PINATA_JWT="your-jwt" ./scripts/register.sh
```

**Option 4: Data URI (fully on-chain)**
Encode your registration as base64 — no external hosting needed:
```bash
./scripts/register-onchain.sh
```

## Registration File Format

Your agent's registration file (stored on IPFS) follows this structure:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "My Agent",
  "description": "An AI assistant for various tasks",
  "image": "https://example.com/avatar.png",
  "services": [
    {
      "name": "web",
      "endpoint": "https://myagent.xyz/"
    },
    {
      "name": "A2A",
      "endpoint": "https://myagent.xyz/.well-known/agent-card.json",
      "version": "0.3.0"
    }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    {
      "agentId": 123,
      "agentRegistry": "eip155:1:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    }
  ],
  "supportedTrust": ["reputation"]
}
```

## Workflow

1. **Bridge ETH** (if needed) - Use Bankr to bridge ETH from Base/L2 to mainnet
2. **Create Profile** - Generate a registration JSON file with agent info
3. **Upload to IPFS** - Pin the file via Pinata (or other provider)
4. **Register On-Chain** - Call `register(agentURI)` on the Identity Registry
5. **Update Profile** - Set metadata, wallet, or update URI as needed

## Costs

- **Gas:** ~100-200k gas for registration (~$5-20 depending on gas prices)
- **IPFS:** Free tier available on Pinata (1GB)

## Using the SDK

For more advanced usage, install the Agent0 SDK:

```bash
npm install agent0-sdk
```

```typescript
import { SDK } from 'agent0-sdk';

const sdk = new SDK({
  chainId: 1, // Ethereum Mainnet
  rpcUrl: process.env.ETH_RPC_URL,
  privateKey: process.env.PRIVATE_KEY,
  ipfs: 'pinata',
  pinataJwt: process.env.PINATA_JWT
});

const agent = sdk.createAgent('My Agent', 'Description', 'https://image.url');
const result = await agent.registerIPFS();
console.log(`Registered: Agent ID ${result.agentId}`);
```

## Links

- [ERC-8004 Spec](https://eips.ethereum.org/EIPS/eip-8004)
- [8004.org](https://www.8004.org)
- [Agent0 SDK Docs](https://sdk.ag0.xyz)
- [GitHub: erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts)
- [GitHub: agent0-ts](https://github.com/agent0lab/agent0-ts)
